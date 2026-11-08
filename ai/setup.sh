#!/bin/sh
# On-device AI for Cutroom: natural voices (Kokoro-82M), text-to-image (Z-Image-Turbo, kept as a 4-bit copy that fits
# in RAM) and object removal (ai/remove.py: OpenCV). The image model downloads ~32 GB once; after the 4-bit copy is
# saved (5.5 GB in ~/Movies/Cutroom/ai) the originals are deleted, so about 6 GB stays on disk in all.
# The language-model features (shorts, caption translation, hook titles) use Ollama: brew install ollama; then
# ollama pull qwen3.5:9b (16 GB of memory or more) or qwen3.5:4b (an 8 GB Mac). Cutroom picks the biggest that fits.
set -eu
cd "$(dirname "$0")"
env -u PYTHONPATH uv venv --python 3.12 .venv
env -u PYTHONPATH uv pip install --python .venv/bin/python mflux mlx-audio "misaki[en]" opencv-python numpy
# voice model + spaCy's English model (misaki installs it through uv on first use, so the venv must be active)
out=$(mktemp -d)
env -u PYTHONPATH VIRTUAL_ENV="$PWD/.venv" PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -I -m mlx_audio.tts.generate \
  --model mlx-community/Kokoro-82M-bf16 --text "Cutroom voices are ready." --voice af_heart --lang_code a \
  --output_path "$out" --file_prefix check --audio_format wav --join_audio
# image model: quantize once to 4-bit (loading the full model every time swaps a 36 GB Mac), then drop the originals.
# Skipped below 12 GB of memory: the 4-bit copy alone is 5.5 GB, and Cutroom refuses to run it there anyway.
ram=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [ "$ram" -ge 12 ]; then
env -u PYTHONPATH .venv/bin/mflux-save --model z-image-turbo --quantize 4 --path "$HOME/Movies/Cutroom/ai/z-image-turbo-4bit"
test -f "$HOME/Movies/Cutroom/ai/z-image-turbo-4bit/mflux_model.json"
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
env -u PYTHONPATH uv pip install --python .venv/bin/python torchvision einops matplotlib imageio imageio-ffmpeg demucs
SAM2_BUILD_CUDA=0 SAM2_BUILD_ALLOW_ERRORS=1 env -u PYTHONPATH uv pip install --python .venv/bin/python -e vendor/sam2  # the PyPI "sam2" is a fork
fetch() { [ -f "$2" ] || curl -sSfL -o "$2" "$1"; echo "$3  $2" | shasum -a 256 -c -; }
fetch https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt vendor/sam2/checkpoints/sam2.1_hiera_small.pt \
  6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38
PP=https://github.com/sczhou/ProPainter/releases/download/v0.1.0
fetch $PP/ProPainter.pth vendor/ProPainter/weights/ProPainter.pth 12c070c4b48f374c91d8a2a17851140b85c159621080989f9e191bbc18bd6591
fetch $PP/recurrent_flow_completion.pth vendor/ProPainter/weights/recurrent_flow_completion.pth 22939a1a7900da878dbe1ccd011d646b1bfb30b8290039d8ff0e0c2fefbfd283
fetch $PP/raft-things.pth vendor/ProPainter/weights/raft-things.pth fcfa4125d6418f4de95d84aec20a3c5f4e205101715a79f193243c186ac9a7e1
# Isolate / remove voice: Demucs (htdemucs) fetches its weights from Hugging Face on first use; do it now
tmp=$(mktemp -d)
env -u PYTHONPATH .venv/bin/python -I -c "import wave; w = wave.open('$tmp/s.wav', 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(bytes(4 * 44100)); w.close()"
env -u PYTHONPATH PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python -I -m demucs --two-stems vocals -d mps -o "$tmp" "$tmp/s.wav" > /dev/null
# AI music: MusicGen small (Meta; weights CC-BY-NC 4.0: personal use), through transformers (already in the venv)
env -u PYTHONPATH .venv/bin/python -I -c "from huggingface_hub import snapshot_download; snapshot_download('facebook/musicgen-small', allow_patterns=['*.json', 'model.safetensors', 'spiece.model'])"
echo "On-device AI ready."
