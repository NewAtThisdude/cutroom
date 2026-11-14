#!/bin/sh
# On-device AI for Cutroom: natural voices (Kokoro-82M), text-to-image (Z-Image-Turbo, kept as a 4-bit copy that fits
# in RAM) and object removal (ai/remove.py: OpenCV). The image model downloads ~32 GB once; after the 4-bit copy is
# saved (5.5 GB in ~/Movies/Cutroom/ai) the originals are deleted, so about 6 GB stays on disk in all.
# The language-model features (shorts, caption translation, hook titles) use Ollama: brew install ollama; then
# ollama pull qwen3.5:9b (16 GB of memory or more) or qwen3.5:4b-q4_K_M (8-12 GB Macs: 3.4 GB loaded; plain qwen3.5:4b is
# an nvfp4 MLX build that takes 4.2 GB). Cutroom picks the biggest that fits.
# Pinned: the Python packages from mac.lock (each file's SHA-256, installed with --require-hashes; made from mac.in), the voice,
# Demucs and MusicGen models at fixed Hugging Face revisions with the weight file checked, repos at fixed commits, weights by
# SHA-256. Not pinned: Z-Image-Turbo (mflux-save fetches the current revision before it makes the 4-bit copy) and Ollama's
# nomic-embed-text:v1.5 (pulled by tag; a warning below when it is not the tested build).
set -eu
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || env -u PYTHONPATH uv venv --python 3.12 .venv  # a re-run (update, retry) keeps it
env -u PYTHONPATH uv pip install --python .venv/bin/python --require-hashes -r mac.lock
# Hugging Face models at pinned revisions, the weight file checked; refs/main is set to that revision so the code that asks for
# "main" (mlx-audio's Kokoro, Demucs, MusicGen) finds this copy offline (the server runs the AI with HF_HUB_OFFLINE=1)
env -u PYTHONPATH .venv/bin/python -I -c "
import hashlib, pathlib
from huggingface_hub import constants, snapshot_download
for repo, rev, pats, f, sha in [
        ('mlx-community/Kokoro-82M-bf16', 'a71e4d38b236d968966a2002c4c895dbd12b1c3c', ['config.json', 'kokoro-v1_0.safetensors', 'voices/*'],
         'kokoro-v1_0.safetensors', '4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8'),
        ('adefossez/HTDemucs', 'cbc8a9b1a87023b7fd74e7b3412e6321c0eab003', ['htdemucs.yaml', '955717e8.safetensors'], '955717e8.safetensors',
         'd9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd'),
        ('facebook/musicgen-small', '4c8334b02c6ec4e8664a91979669a501ec497792', ['*.json', 'model.safetensors', 'spiece.model'], 'model.safetensors',
         '1bdc99d43eb6c775967df24b65b0a9f847c0907e95664698d93b5a1c35f5090d')]:
    d = snapshot_download(repo, revision=rev, allow_patterns=pats)
    h = hashlib.sha256()
    with open(f'{d}/{f}', 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 24), b''):
            h.update(b)
    assert h.hexdigest() == sha, (repo, f, h.hexdigest())
    ref = pathlib.Path(constants.HF_HUB_CACHE) / ('models--' + repo.replace('/', '--')) / 'refs' / 'main'
    ref.parent.mkdir(parents=True, exist_ok=True)
    ref.write_text(rev)
    print('ok', repo)"
# the voice check (spaCy's English model is in mac.lock, so misaki has nothing to fetch)
out=$(mktemp -d)
env -u PYTHONPATH HF_HUB_OFFLINE=1 VIRTUAL_ENV="$PWD/.venv" PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -I -m mlx_audio.tts.generate \
  --model mlx-community/Kokoro-82M-bf16 --text "Cutroom voices are ready." --voice af_heart --lang_code a \
  --output_path "$out" --file_prefix check --audio_format wav --join_audio
# image model: quantize once to 4-bit (loading the full model every time swaps a 36 GB Mac), then drop the originals.
# Skipped below 12 GB of memory: the 4-bit copy alone is 5.5 GB, and Cutroom refuses to run it there anyway.
ram=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [ "$ram" -ge 12 ]; then
env -u PYTHONPATH .venv/bin/mflux-save --model z-image-turbo --quantize 4 --path "${CUTROOM_HOME:-$HOME/Movies/Cutroom}/ai/z-image-turbo-4bit"
test -f "${CUTROOM_HOME:-$HOME/Movies/Cutroom}/ai/z-image-turbo-4bit/mflux_model.json"
env -u PYTHONPATH .venv/bin/python -I -c "
from huggingface_hub import scan_cache_dir
c = scan_cache_dir()
revs = [r.commit_hash for repo in c.repos if repo.repo_id == 'Tongyi-MAI/Z-Image-Turbo' for r in repo.revisions]
if revs:
    s = c.delete_revisions(*revs); print('freed', s.expected_freed_size_str); s.execute()"
else echo "Skipping the image model: it needs 16 GB of memory (this Mac has $ram GB)."; fi
# Best object removal and any-subject cutouts: SAM 2 (Meta, Apache-2.0) and ProPainter (S-Lab NTU licence: personal /
# non-commercial use), from their official repos at pinned commits; weights from their own release servers, checked.
mkdir -p vendor
[ -d vendor/sam2 ] || git clone -q https://github.com/facebookresearch/sam2.git vendor/sam2
git -C vendor/sam2 checkout -q 2b90b9f5ceec907a1c18123530e92e794ad901a4
[ -d vendor/ProPainter ] || git clone -q https://github.com/sczhou/ProPainter.git vendor/ProPainter
git -C vendor/ProPainter checkout -q 326782529a63d997cab80ab21439b92ed422b3d3
# Their Python packages are in mac.lock, with Demucs and pyworld 0.3.5 (the WORLD vocoder for the voice characters elf / giant /
# monster / alien, ai/voicefx.py: MIT; WORLD itself modified BSD). SAM 2 is used from its folder through a .pth file (the PyPI
# "sam2" is a fork): without its CUDA extension it is plain Python, so nothing is built
echo "$PWD/vendor/sam2" > "$(env -u PYTHONPATH .venv/bin/python -I -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')/cutroom-sam2.pth"
fetch() { [ -f "$2" ] || curl -sSfL -o "$2" "$1"; echo "$3  $2" | shasum -a 256 -c -; }
fetch https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt vendor/sam2/checkpoints/sam2.1_hiera_small.pt \
  6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38
PP=https://github.com/sczhou/ProPainter/releases/download/v0.1.0
fetch $PP/ProPainter.pth vendor/ProPainter/weights/ProPainter.pth 12c070c4b48f374c91d8a2a17851140b85c159621080989f9e191bbc18bd6591
fetch $PP/recurrent_flow_completion.pth vendor/ProPainter/weights/recurrent_flow_completion.pth 22939a1a7900da878dbe1ccd011d646b1bfb30b8290039d8ff0e0c2fefbfd283
fetch $PP/raft-things.pth vendor/ProPainter/weights/raft-things.pth fcfa4125d6418f4de95d84aec20a3c5f4e205101715a79f193243c186ac9a7e1
# Isolate / remove voice: Demucs (htdemucs, its weights pinned above), checked once on the GPU
tmp=$(mktemp -d)
env -u PYTHONPATH .venv/bin/python -I -c "import wave; w = wave.open('$tmp/s.wav', 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(bytes(4 * 44100)); w.close()"
env -u PYTHONPATH HF_HUB_OFFLINE=1 PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python -I -m demucs --two-stems vocals -d mps -o "$tmp" "$tmp/s.wav" > /dev/null
# AI music: MusicGen small (Meta; weights CC-BY-NC 4.0: personal use; pinned above), through transformers, and its half-precision
# copy (vendor/musicgen-small-fp16): music.py loads it straight onto the GPU, 2.4 GB peak instead of 4.2+
env -u PYTHONPATH HF_HUB_OFFLINE=1 .venv/bin/python -I -c "import sys; sys.path.insert(0, '.'); import music, torch; music.load(torch.device('mps'))"
# AI enhance (ai/enhance.py, PyTorch on the GPU): RIFE 4.25 frame interpolation for Smooth slow-mo (Practical-RIFE by hzwer,
# MIT; the model file from HolyWu's vs-rife, MIT, pinned commit; weights from its release), Real-ESRGAN general x4v3 + its
# -wdn twin for AI upscale (xinntao, BSD-3), Depth Anything V2 Small for relight (Apache-2.0, through transformers). ~130 MB.
mkdir -p vendor/enhance/rife
touch vendor/enhance/rife/__init__.py
VR=https://raw.githubusercontent.com/HolyWu/vs-rife/3488617283db7c428a83ba4a19382285da698b6a
fetch $VR/vsrife/IFNet_HDv3_v4_25.py vendor/enhance/rife/IFNet_HDv3_v4_25.py faf8e6ef4579b1049011a8e4139fb4e790ec220bd6ecab75f5acb8d01d1456b2
fetch $VR/vsrife/warplayer.py vendor/enhance/rife/warplayer.py f17b5aea73676c059b4c155852217c954d5b4eb19cc08eff40b43edd6055ab73
fetch $VR/LICENSE vendor/enhance/rife/LICENSE aea942caf766b16e6ef0b26e033fa92c0dea3124f6f7ad4a18ca1fb43e010d40
fetch https://github.com/HolyWu/vs-rife/releases/download/model/flownet_v4.25.pkl vendor/enhance/flownet_v4.25.pkl 6615790efd627772917205db291f51cd392528a157ecbb2ecaeec3bff8eb6de2
ES=https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0
fetch $ES/realesr-general-x4v3.pth vendor/enhance/realesr-general-x4v3.pth 8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292
fetch $ES/realesr-general-wdn-x4v3.pth vendor/enhance/realesr-general-wdn-x4v3.pth 1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca
env -u PYTHONPATH .venv/bin/python -I -c "
import hashlib
from huggingface_hub import snapshot_download
p = snapshot_download('depth-anything/Depth-Anything-V2-Small-hf', revision='5426e4f0f36572d16453bbda7a8389317b1bef99', allow_patterns=['*.json', 'model.safetensors'])
assert hashlib.sha256(open(p + '/model.safetensors', 'rb').read()).hexdigest() == '3152477ce0d8d6978d76b995120de97cb5b928701fd0f817769f59e249a16b70'"
# the CC0 sound and music library (packs.json: Kenney sound packs + CC0 music from archive.org, ~100 MB, each SHA-256 and licence
# checked) into the library's packs folder. Not AI, but the same one-time setup; the Audio rail can also download it
env -u PYTHONPATH python3 -I ../server.py --packs
# Smart search in the Media panel: text embeddings (nomic-embed-text v1.5, Apache-2.0, 137M parameters, 274 MB) in Ollama;
# Ollama checks the blob's sha256 itself. Pinned manifest digest: 0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f
if command -v ollama > /dev/null; then
  ollama pull nomic-embed-text:v1.5 > /dev/null
  curl -s http://127.0.0.1:11434/api/tags | grep -q '"nomic-embed-text:v1.5".*0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f' \
    || echo "warning: nomic-embed-text:v1.5 is not the pinned build (search still works, scores may differ)"
fi
# Speaker labels: WavLM Base Plus speaker verification (Microsoft; licence CC BY-SA 3.0: the HF card's "License" section points
# to microsoft/UniSpeech/LICENSE), 386 MB, via transformers; pinned revision, weights checked. No token needed (pyannote's is gated).
env -u PYTHONPATH .venv/bin/python -I -c "from huggingface_hub import snapshot_download; snapshot_download('microsoft/wavlm-base-plus-sv', revision='feb593a6c23c1cc3d9510425c29b0a14d2b07b1e', allow_patterns=['*.json', 'pytorch_model.bin'], local_dir='vendor/wavlm-base-plus-sv')"
echo "e906bce2fa42fb497a1d1a9ecf81548adb7e03b12a5644e32d2f42f0d6500fad  vendor/wavlm-base-plus-sv/pytorch_model.bin" | shasum -a 256 -c -
# Voice clone + dubbing: Chatterbox multilingual v3 (Resemble AI, MIT; 23 languages, 2.7 GB) with its S3 tokenizer
# (mlx-community/S3TokenizerV2, converted from FunAudioLLM/CosyVoice2-0.5B: Apache-2.0; 0.5 GB), and WavLM speaker verification
# (microsoft/wavlm-base-plus-sv: CC BY-SA 3.0 via microsoft/UniSpeech's LICENSE, attribution required; 0.4 GB) to measure how close
# a clone sounds. Pinned revisions, the weight files' SHA-256 checked (ai/worker.py checks them again and runs offline, HF_HUB_OFFLINE=1).
env -u PYTHONPATH .venv/bin/python -I -c "
import hashlib
from huggingface_hub import snapshot_download
for repo, rev, f, sha in [('mlx-community/chatterbox-multilingual-v3', '03565773edd72e949572557597af8063bb49a18a', 'model.safetensors', 'e702f2c441e040bd360e59a86c85d462539759d665e41cfd1938adadd74187a3'),
                          ('mlx-community/S3TokenizerV2', 'e0c9886f0e1c35ae85b1f27277416fb19fc72bec', 'model.safetensors', '928726bc1f206a613d36b8f49e297eae9c5593a21bf9b92ddfe2c23f85eb92cc'),
                          ('microsoft/wavlm-base-plus-sv', 'feb593a6c23c1cc3d9510425c29b0a14d2b07b1e', 'pytorch_model.bin', 'e906bce2fa42fb497a1d1a9ecf81548adb7e03b12a5644e32d2f42f0d6500fad')]:
    d = snapshot_download(repo, revision=rev)
    h = hashlib.sha256()
    with open(f'{d}/{f}', 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 24), b''):
            h.update(b)
    assert h.hexdigest() == sha, (repo, f, h.hexdigest())
    print('ok', repo)"
# Lip sync (LatentSync 1.6) and talking photos (Wan 2.2 S2V) run on the RTX 4090 PC: ai/gpu_setup.sh (licences listed there).
echo "On-device AI ready."
