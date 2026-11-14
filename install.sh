#!/bin/sh
# Cutroom on a Mac, one line in Terminal:   curl -fsSL <url>/install.sh | sh
# or from a copy of the source:            ./install.sh
# Checks the tools (offers Homebrew's ffmpeg and whisper-cpp when they are missing), fetches the two speech models, runs
# `cutroom check` and installs the AI pack this Mac can run (Apple Silicon: the MLX pack, ai/setup.sh), then builds the app.
# Every file this script downloads is pinned and checked by SHA-256, and so are the MLX pack's packages (ai/mac.lock, installed
# with --require-hashes). Not pinned: Homebrew's ffmpeg, whisper-cpp and python (its current versions; Homebrew checks its own
# downloads) and the MLX pack's Z-Image-Turbo (its current revision). Everything goes into the prefix, the library and
# ~/Applications/Cutroom.app: no sudo, no PATH or login-item change. Safe to run again. Settings:
#   CUTROOM_PREFIX   the source (when downloaded) and uv          (default ~/.local/share/cutroom)
#   CUTROOM_HOME     the library: media, projects, exports, models (default ~/Movies/Cutroom)
#   CUTROOM_APP      where the app is built, or none               (default ~/Applications/Cutroom.app)
#   CUTROOM_AI       auto | mlx | none                             (default auto: what `cutroom check` picks)
#   CUTROOM_YES=1    no questions (Homebrew installs, the AI pack)
#   CUTROOM_SRC, CUTROOM_SRC_SHA256   the source .tar.gz and its SHA-256, when not run from a copy of the source
set -eu
SRC_URL=https://github.com/REPLACE-ME/cutroom/archive/refs/tags/v1.0.tar.gz  # the release this installer belongs to, and its
SRC_SHA256=REPLACE-ME                                                      # SHA-256: both set when the source is published
UV_URL=https://github.com/astral-sh/uv/releases/download/0.13.6/uv-aarch64-apple-darwin.tar.gz  # uv 0.13.6 (MIT / Apache-2.0)
UV_SHA256=60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472

say() { printf '%s\n' "$*"; }
die() { say "$*" >&2; exit 1; }
ask() { # yes unless the answer starts with n; CUTROOM_YES=1, or no terminal to ask on: yes
  [ "${CUTROOM_YES:-}" = 1 ] && return 0
  { : < /dev/tty; } 2> /dev/null || return 0
  printf '%s [Y/n] ' "$1"
  read -r a < /dev/tty || a=
  case $a in n* | N*) return 1 ;; esac
}
fetch() { # url file sha256: once; a file that doesn't match is deleted, never used
  if [ -f "$2" ] && [ "$(shasum -a 256 "$2" | cut -d' ' -f1)" = "$3" ]; then return; fi
  say "Downloading $(basename "$2")"
  curl -fL --retry 3 -o "$2.part" "$1" < /dev/null
  [ "$(shasum -a 256 "$2.part" | cut -d' ' -f1)" = "$3" ] || { rm -f "$2.part"; die "Checksum mismatch for $1"; }
  mv "$2.part" "$2"
}

main() { # (one function, called on the last line: piped into sh, nothing runs before the whole script has arrived)
  [ "$(uname -s)" = Darwin ] || die 'install.sh is for macOS. On Windows, in PowerShell: irm <url>/install.ps1 | iex'
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  PREFIX=${CUTROOM_PREFIX:-$HOME/.local/share/cutroom}
  LIB=${CUTROOM_HOME:-$HOME/Movies/Cutroom}
  mkdir -p "$PREFIX/bin" "$LIB/models"

  # 1. the source: this copy, or the release tarball (pinned) unpacked into <prefix>/src; an update keeps the AI pack
  case $0 in */install.sh | install.sh) here=$(cd "$(dirname "$0")" && pwd) ;; *) here= ;; esac
  if [ -n "$here" ] && [ -f "$here/server.py" ]; then
    SRC=$here
  else
    url=${CUTROOM_SRC:-$SRC_URL} sha=${CUTROOM_SRC_SHA256:-$SRC_SHA256}
    case "$url $sha" in *REPLACE-ME*) die 'The Cutroom source is not published yet: set CUTROOM_SRC (a .tar.gz of it) and CUTROOM_SRC_SHA256, then run this again.' ;; esac
    SRC=$PREFIX/src
    fetch "$url" "$PREFIX/src.tar.gz" "$sha"
    rm -rf "$SRC.new" && mkdir "$SRC.new"
    tar -xzf "$PREFIX/src.tar.gz" -C "$SRC.new" --strip-components 1  # (a GitHub tarball holds one folder)
    [ -f "$SRC.new/server.py" ] || die "$url is not a Cutroom source tarball"
    for d in ai/.venv ai/vendor; do [ ! -e "$SRC/$d" ] || mv "$SRC/$d" "$SRC.new/$d"; done
    rm -rf "$SRC" && mv "$SRC.new" "$SRC" && rm "$PREFIX/src.tar.gz"
  fi
  say "Source: $SRC"

  # 2. the tools: Python 3.10+, ffmpeg and whisper.cpp from Homebrew (offered when missing), uv (pinned, into the prefix)
  missing=
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2> /dev/null < /dev/null || missing="$missing python"
  command -v ffmpeg > /dev/null || missing="$missing ffmpeg"
  command -v whisper-cli > /dev/null || missing="$missing whisper-cpp"
  if [ -n "$missing" ]; then
    command -v brew > /dev/null || die "Cutroom needs:$missing. Install Homebrew (https://brew.sh), then: brew install$missing; then run this again."
    ask "Cutroom needs:$missing. Install them with Homebrew now?" || die "Install them (brew install$missing), then run this again."
    brew install $missing < /dev/null
  fi
  if [ ! -x "$PREFIX/bin/uv" ] && ! command -v uv > /dev/null; then
    fetch "$UV_URL" "$PREFIX/bin/uv.tar.gz" "$UV_SHA256"
    tar -xzf "$PREFIX/bin/uv.tar.gz" -C "$PREFIX/bin" --strip-components 1 && rm "$PREFIX/bin/uv.tar.gz"
  fi
  export PATH="$PREFIX/bin:$PATH" CUTROOM_HOME="$LIB"

  # 3. the speech models: Whisper large-v3-turbo q5_0 (MIT, 574 MB; a copy VoiceInk already has is used instead) and Silero VAD (MIT, 1 MB)
  VI="$HOME/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin"
  [ -f "$VI" ] || fetch https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin \
    "$LIB/models/ggml-large-v3-turbo-q5_0.bin" 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
  fetch https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin \
    "$LIB/models/ggml-silero-v5.1.2.bin" 29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf

  # 4. cutroom check: this Mac in plain words, and the AI pack it can run
  report=$(env -u PYTHONPATH python3 -I "$SRC/server.py" --check < /dev/null) || die "cutroom check failed: $report"
  printf '%s\n' "$report" | grep -v '^pack: '
  pack=$(printf '%s\n' "$report" | sed -n 's/^pack: //p')
  case $pack in
    mlx)
      if ask "Install the MLX AI pack now (about 45 GB to download, ~13 GB kept, into $SRC/ai and $LIB/ai)?"; then
        (cd "$SRC/ai" && sh ./setup.sh < /dev/null) || die "The AI pack did not install. Run this again to retry; finished downloads are kept."
      else
        say "Skipped. Later: $SRC/ai/setup.sh"
      fi ;;
    *) say 'No AI pack for this Mac (the reason is above). The editor, captions and exports work without it.' ;;
  esac

  # 5. the app (a native window around the server): needs the Swift compiler; without it ./cutroom opens Chrome instead
  APP=${CUTROOM_APP:-$HOME/Applications/Cutroom.app}
  if [ "$APP" = none ]; then
    say "No app (CUTROOM_APP=none). Start Cutroom with: $SRC/cutroom"
  elif command -v swiftc > /dev/null; then
    CUTROOM_APP="$APP" sh "$SRC/app/build.sh" < /dev/null
    say "Done. Open $APP (or run $SRC/cutroom for a browser window)."
  else
    say "Done. No Swift compiler (xcode-select --install), so no app: start Cutroom with $SRC/cutroom (a Chrome window)."
  fi
  say "This Mac's profile again: $SRC/cutroom check. The Audio tab downloads the free CC0 sound library."
}

main "$@"
