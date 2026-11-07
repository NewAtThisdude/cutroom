#!/bin/sh
# On-device AI for Cutroom: natural voices (Kokoro-82M), text-to-image (Z-Image-Turbo, kept as a 4-bit copy that fits
# in RAM) and object removal (ai/remove.py: OpenCV). The image model downloads ~32 GB once; after the 4-bit copy is
# saved (5.5 GB in ~/Movies/Cutroom/ai) the originals are deleted, so about 6 GB stays on disk in all.
# The language-model features (shorts, caption translation, hook titles) use Ollama: brew install ollama; ollama pull qwen3.5:9b
set -eu
cd "$(dirname "$0")"
env -u PYTHONPATH uv venv --python 3.12 .venv
env -u PYTHONPATH uv pip install --python .venv/bin/python mflux mlx-audio "misaki[en]" opencv-python numpy
# voice model + spaCy's English model (misaki installs it through uv on first use, so the venv must be active)
out=$(mktemp -d)
env -u PYTHONPATH VIRTUAL_ENV="$PWD/.venv" PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -I -m mlx_audio.tts.generate \
  --model mlx-community/Kokoro-82M-bf16 --text "Cutroom voices are ready." --voice af_heart --lang_code a \
  --output_path "$out" --file_prefix check --audio_format wav --join_audio
# image model: quantize once to 4-bit (loading the full model every time swaps a 36 GB Mac), then drop the originals
env -u PYTHONPATH .venv/bin/mflux-save --model z-image-turbo --quantize 4 --path "$HOME/Movies/Cutroom/ai/z-image-turbo-4bit"
test -f "$HOME/Movies/Cutroom/ai/z-image-turbo-4bit/mflux_model.json"
env -u PYTHONPATH .venv/bin/python -I -c "
from huggingface_hub import scan_cache_dir
c = scan_cache_dir()
revs = [r.commit_hash for repo in c.repos if repo.repo_id == 'Tongyi-MAI/Z-Image-Turbo' for r in repo.revisions]
if revs:
    s = c.delete_revisions(*revs); print('freed', s.expected_freed_size_str); s.execute()"
echo "On-device AI ready."
