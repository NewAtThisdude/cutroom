#!/bin/sh
# On-device AI for Cutroom: natural voices (Kokoro-82M) and text-to-image (Z-Image-Turbo, kept as a 4-bit copy that fits in RAM).
# One-time download: about 32 GB into ~/.cache/huggingface (the 4-bit copy in ~/Movies/Cutroom/ai is 5.5 GB).
set -eu
cd "$(dirname "$0")"
env -u PYTHONPATH uv venv --python 3.12 .venv
env -u PYTHONPATH uv pip install --python .venv/bin/python mflux mlx-audio "misaki[en]"
# voice model + spaCy's English model (misaki installs it through uv on first use, so the venv must be active)
out=$(mktemp -d)
env -u PYTHONPATH VIRTUAL_ENV="$PWD/.venv" PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -I -m mlx_audio.tts.generate \
  --model mlx-community/Kokoro-82M-bf16 --text "Cutroom voices are ready." --voice af_heart --lang_code a \
  --output_path "$out" --file_prefix check --audio_format wav --join_audio
# image model: quantize once to 4-bit (loading the full model every time swaps a 36 GB Mac)
env -u PYTHONPATH .venv/bin/mflux-save --model z-image-turbo --quantize 4 --path "$HOME/Movies/Cutroom/ai/z-image-turbo-4bit"
echo "On-device AI ready."
