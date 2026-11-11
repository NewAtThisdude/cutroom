#!/bin/sh
# Cutroom, first-time setup on an Apple Silicon Mac: checks the tools, fetches the two speech models (checksummed) and
# builds the app. Safe to run again. The optional on-device AI tools (image, voice, object removal...) are ai/setup.sh.
set -eu
cd "$(dirname "$0")"
LIB="${CUTROOM_HOME:-$HOME/Movies/Cutroom}"
need() { command -v "$1" > /dev/null || { echo "Missing $1: $2"; exit 1; }; }
need python3 "install Python 3.10 or newer (brew install python)"
need ffmpeg "brew install ffmpeg"
need whisper-cli "brew install whisper-cpp"
need swiftc "xcode-select --install"
fetch() { # url file sha256
  if [ -f "$2" ] && [ "$(shasum -a 256 "$2" | cut -d' ' -f1)" = "$3" ]; then return; fi
  echo "Downloading $(basename "$2")"
  curl -fL --retry 3 -o "$2.part" "$1"
  [ "$(shasum -a 256 "$2.part" | cut -d' ' -f1)" = "$3" ] || { rm -f "$2.part"; echo "Checksum mismatch for $2"; exit 1; }
  mv "$2.part" "$2"
}
mkdir -p "$LIB/models"
VI="$HOME/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin"
[ -f "$VI" ] || fetch https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin \
  "$LIB/models/ggml-large-v3-turbo-q5_0.bin" 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2  # MIT (OpenAI Whisper), 574 MB
fetch https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin \
  "$LIB/models/ggml-silero-v5.1.2.bin" 29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf  # MIT (Silero VAD), 1 MB
sh app/build.sh
echo "Done. Open ~/Applications/Cutroom.app (or run ./cutroom for a browser window)."
echo "Optional: ai/setup.sh installs the on-device AI tools; the Audio tab downloads the free CC0 sound library."
