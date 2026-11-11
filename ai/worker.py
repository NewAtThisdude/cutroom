"""Cutroom's AI worker: one long-lived process that keeps SAM 2's image model (and the frame it last embedded) and Kokoro
loaded between requests. Starting a process per outline click reloaded SAM 2 every time (3.7-36 s per click).

  worker.py <idle seconds>    reads one JSON request per line on stdin, answers one JSON line each on stdout:
    {"id": n, "op": "preview", "job": {...}}                -> {"id": n, "result": {...}}   (remove.preview)
    {"id": n, "op": "voice", "text", "voice", "speed", "out"} -> {"id": n, "result": {}}      (Kokoro, a WAV at out)
    {"id": n, "op": "relight", "job": {...}}                -> {"id": n, "result": {w, h}} (enhance.preview, a PNG at out)
    {"id": n, "op": "clone", "text", "ref", "lang", "out"}    -> {"id": n, "result": {"sr"}}  (Chatterbox voice clone)
    {"id": n, "op": "embed", "files": [raw s16 16k, ...]}     -> {"id": n, "result": {"sims"}} (speaker cosine vs files[0])
    any failure                                              -> {"id": n, "error": "..."}
Exits after <idle> seconds without a request (0 = after each answer), when the server closes stdin (another heavy job
needs the memory: server.py worker_stop), or when
the server goes (stdin closes). Model output and warnings go to stderr: stdout carries only the answers.
"""
import json
import os
import select
import sys
from pathlib import Path

KOKORO = 'mlx-community/Kokoro-82M-bf16'
out = os.fdopen(os.dup(1), 'w', buffering=1)
os.dup2(2, 1)  # anything a library prints lands in the log, not in an answer
sys.stdout = sys.stderr
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remove  # noqa: E402

models = {}
SMALL = os.environ.get('CUTROOM_SMALL') == '1'  # an 8-16 GB Mac (server.py): one model in memory at a time, Chatterbox in bf16


def small_mlx():
    """Small Mac: MLX keeps at most 256 MB of freed buffers for reuse (it held every step's activations: Chatterbox 4.7 GB peak)."""
    if SMALL:
        import mlx.core as mx
        mx.set_cache_limit(256 << 20)


def bf16_copy(src):
    """A bfloat16 copy of a pinned (already checksummed) MLX model folder, made once in vendor/: loading it peaks at half the
    float32 file, where loading float32 and casting peaked at 5 GB."""
    import mlx.core as mx
    dst = Path(__file__).resolve().parent / 'vendor' / (Path(src).parent.parent.name + '-bf16')
    if not (dst / 'model.safetensors').exists():
        tmp = dst.with_name(dst.name + '.tmp')
        tmp.mkdir(parents=True, exist_ok=True)
        for f in Path(src).iterdir():
            if f.name != 'model.safetensors' and not (tmp / f.name).exists():
                (tmp / f.name).symlink_to(f.resolve())
        w, meta = mx.load(str(Path(src) / 'model.safetensors'), return_metadata=True)
        mx.save_safetensors(str(tmp / 'model.safetensors'), {k: v.astype(mx.bfloat16) if v.dtype == mx.float32 else v for k, v in w.items()}, metadata=meta)
        del w
        tmp.replace(dst)
    return str(dst)


def only(name):
    """On a small Mac, drop every other loaded model before this one loads: a clone check loads Chatterbox, Kokoro and WavLM
    in turn, and all three at once peaked at 6.1 GB (an 8 GB Mac has about 4 for AI)."""
    if not SMALL or set(models) <= {name}:
        return
    import gc
    for k in [k for k in models if k != name]:
        del models[k]
    gc.collect()
    if 'mlx.core' in sys.modules:
        sys.modules['mlx.core'].clear_cache()
    if 'torch' in sys.modules and sys.modules['torch'].backends.mps.is_available():
        sys.modules['torch'].mps.empty_cache()


def voice(req):
    from mlx_audio.tts.generate import generate_audio
    from mlx_audio.tts.utils import load_model
    only('kokoro')
    small_mlx()
    if 'kokoro' not in models:
        models['kokoro'] = load_model(model_path=KOKORO)
    base = req['out'][:-4]
    generate_audio(req['text'], model=models['kokoro'], voice=req['voice'], speed=req['speed'], lang_code=req['voice'][0],
                   file_prefix=base, audio_format='wav', join_audio=True, verbose=False)
    if not os.path.exists(req['out']):  # generate_audio prints its errors instead of raising them
        raise RuntimeError('Kokoro made no audio')
    return {}


# The clone/embed models, pinned (repo, revision, file, SHA-256: the same as ai/setup.sh). The server runs this worker with
# HF_HUB_OFFLINE=1, so nothing is downloaded at run time; mlx-audio asks for the S3 tokenizer without a revision (the hub's
# "main" ref), so pinned() checks that "main" is our revision and every weight file's checksum before a model loads.
CLONE = ('mlx-community/chatterbox-multilingual-v3', '03565773edd72e949572557597af8063bb49a18a', 'model.safetensors',
         'e702f2c441e040bd360e59a86c85d462539759d665e41cfd1938adadd74187a3')  # Resemble AI Chatterbox, MIT
S3TOK = ('mlx-community/S3TokenizerV2', 'e0c9886f0e1c35ae85b1f27277416fb19fc72bec', 'model.safetensors',
         '928726bc1f206a613d36b8f49e297eae9c5593a21bf9b92ddfe2c23f85eb92cc')  # from FunAudioLLM/CosyVoice2-0.5B, Apache-2.0
WAVLM = ('microsoft/wavlm-base-plus-sv', 'feb593a6c23c1cc3d9510425c29b0a14d2b07b1e', 'pytorch_model.bin',
         'e906bce2fa42fb497a1d1a9ecf81548adb7e03b12a5644e32d2f42f0d6500fad')  # speaker verification x-vectors, CC BY-SA 3.0 (UniSpeech LICENSE; attribution)


def pinned(repo, rev, f, sha, main=False):
    """The local snapshot of repo at rev, its weight file checksummed (once per process); main=True: the hub's unrevisioned
    lookup must land on it too (for code that asks without a revision)."""
    import hashlib
    from huggingface_hub import snapshot_download
    d = snapshot_download(repo, revision=rev)  # offline: the cached copy or an error, never a download
    if main and os.path.realpath(snapshot_download(repo)) != os.path.realpath(d):
        raise RuntimeError(f'{repo}: the cached "main" is not the pinned revision {rev[:10]}; run ai/setup.sh')
    h = hashlib.sha256()
    with open(os.path.join(d, f), 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 24), b''):
            h.update(b)
    if h.hexdigest() != sha:
        raise RuntimeError(f'{repo}/{f} does not match its pinned checksum; run ai/setup.sh')
    return d


def clone(req):
    """Zero-shot voice clone (Chatterbox multilingual, 23 languages): speak text in the voice of the reference WAV."""
    import wave
    import numpy as np
    from mlx_audio.tts.utils import load_model
    only('clone')
    small_mlx()
    if 'clone' not in models:
        pinned(*S3TOK, main=True)  # mlx-audio loads it as snapshot_download('mlx-community/S3TokenizerV2'): no revision
        d = pinned(*CLONE)  # small Mac: its bfloat16 copy (3.5 GB peak, not 6.1; the clone still beats every stock voice: tests/allmacs.mjs)
        models['clone'] = load_model(model_path=bf16_copy(d) if SMALL else d)
    m = models['clone']
    a = np.concatenate([np.array(r.audio) for r in m.generate(req['text'], ref_audio=req['ref'], lang_code=req['lang'], verbose=False,
                                                              cfg_weight=req.get('cfg', 0.5), exaggeration=req.get('exag', 0.1))])
    with wave.open(req['out'], 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(m.sample_rate)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype('<i2').tobytes())
    return {'sr': m.sample_rate}


def embed(req):
    """Speaker similarity: cosine of WavLM x-vectors, each file against the first (16 kHz mono s16 raw files)."""
    import numpy as np
    import torch
    from transformers import AutoFeatureExtractor, WavLMForXVector
    only('wavlm')
    if 'wavlm' not in models:
        d = pinned(*WAVLM)
        net = WavLMForXVector.from_pretrained(d)
        net.train(False)
        models['wavlm'] = (AutoFeatureExtractor.from_pretrained(d), net)
    fe, net = models['wavlm']
    es = []
    for f in req['files']:
        x = fe(np.fromfile(f, '<i2').astype(np.float32) / 32768, sampling_rate=16000, return_tensors='pt')
        with torch.no_grad():
            es.append(torch.nn.functional.normalize(net(**x).embeddings[0], dim=-1))
    return {'sims': [round(float(es[0] @ e), 4) for e in es[1:]]}


def relight(req):
    import enhance  # torch + the depth model only when a relight preview is asked for
    return enhance.preview(req['job'])


OPS = {'preview': lambda req: remove.preview(req['job']), 'voice': voice, 'clone': clone, 'embed': embed, 'relight': relight}


def main(idle):
    while True:
        if idle and not select.select([sys.stdin], [], [], idle)[0]:
            return
        line = sys.stdin.readline()
        if not line:
            return
        req = json.loads(line)
        try:
            res = {'id': req.get('id'), 'result': OPS[req['op']](req)}
        except Exception as e:  # sent back to the editor
            res = {'id': req.get('id'), 'error': str(e) or type(e).__name__}
        out.write(json.dumps(res) + '\n')
        if not idle:
            return


if __name__ == '__main__':
    main(float(sys.argv[1]) if len(sys.argv) > 1 else 300)
