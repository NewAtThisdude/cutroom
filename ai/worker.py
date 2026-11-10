"""Cutroom's AI worker: one long-lived process that keeps SAM 2's image model (and the frame it last embedded) and Kokoro
loaded between requests. Starting a process per outline click reloaded SAM 2 every time (3.7-36 s per click).

  worker.py <idle seconds>    reads one JSON request per line on stdin, answers one JSON line each on stdout:
    {"id": n, "op": "preview", "job": {...}}                -> {"id": n, "result": {...}}   (remove.preview)
    {"id": n, "op": "voice", "text", "voice", "speed", "out"} -> {"id": n, "result": {}}      (Kokoro, a WAV at out)
    {"id": n, "op": "clone", "text", "ref", "lang", "out"}    -> {"id": n, "result": {"sr"}}  (Chatterbox voice clone)
    {"id": n, "op": "embed", "files": [raw s16 16k, ...]}     -> {"id": n, "result": {"sims"}} (speaker cosine vs files[0])
    any failure                                              -> {"id": n, "error": "..."}
Exits after <idle> seconds without a request (0 = after each answer: a Mac under 16 GB needs that memory back), or when
the server goes (stdin closes). Model output and warnings go to stderr: stdout carries only the answers.
"""
import json
import os
import select
import sys

KOKORO = 'mlx-community/Kokoro-82M-bf16'
out = os.fdopen(os.dup(1), 'w', buffering=1)
os.dup2(2, 1)  # anything a library prints lands in the log, not in an answer
sys.stdout = sys.stderr
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remove  # noqa: E402

models = {}


def voice(req):
    from mlx_audio.tts.generate import generate_audio
    from mlx_audio.tts.utils import load_model
    if 'kokoro' not in models:
        models['kokoro'] = load_model(model_path=KOKORO)
    base = req['out'][:-4]
    generate_audio(req['text'], model=models['kokoro'], voice=req['voice'], speed=req['speed'], lang_code=req['voice'][0],
                   file_prefix=base, audio_format='wav', join_audio=True, verbose=False)
    if not os.path.exists(req['out']):  # generate_audio prints its errors instead of raising them
        raise RuntimeError('Kokoro made no audio')
    return {}


CLONE = ('mlx-community/chatterbox-multilingual-v3', '03565773edd72e949572557597af8063bb49a18a')  # Resemble AI Chatterbox, MIT
WAVLM = ('microsoft/wavlm-base-plus-sv', 'feb593a6c23c1cc3d9510425c29b0a14d2b07b1e')  # speaker verification x-vectors, CC BY-SA 3.0 (UniSpeech LICENSE; attribution)


def clone(req):
    """Zero-shot voice clone (Chatterbox multilingual, 23 languages): speak text in the voice of the reference WAV."""
    import wave
    import numpy as np
    from huggingface_hub import snapshot_download
    from mlx_audio.tts.utils import load_model
    if 'clone' not in models:
        models['clone'] = load_model(model_path=snapshot_download(CLONE[0], revision=CLONE[1]))
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
    if 'wavlm' not in models:
        net = WavLMForXVector.from_pretrained(WAVLM[0], revision=WAVLM[1])
        net.train(False)
        models['wavlm'] = (AutoFeatureExtractor.from_pretrained(WAVLM[0], revision=WAVLM[1]), net)
    fe, net = models['wavlm']
    es = []
    for f in req['files']:
        x = fe(np.fromfile(f, '<i2').astype(np.float32) / 32768, sampling_rate=16000, return_tensors='pt')
        with torch.no_grad():
            es.append(torch.nn.functional.normalize(net(**x).embeddings[0], dim=-1))
    return {'sims': [round(float(es[0] @ e), 4) for e in es[1:]]}


OPS = {'preview': lambda req: remove.preview(req['job']), 'voice': voice, 'clone': clone, 'embed': embed}


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
