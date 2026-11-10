#!/bin/sh
# Lip sync and talking photos run on the RTX 4090 PC (CUTROOM_GPU_HOST, an ~/.ssh/config alias, default win4090).
# This copies ai/gpu_setup.ps1 there and runs it: LatentSync 1.6 in its own venv (lip sync of real footage) and the Wan 2.2 S2V
# weights in its ComfyUI (talking photos); ~30 GB, every weight SHA-256 checked, licences listed in gpu_setup.ps1.
set -eu
cd "$(dirname "$0")"
H=${CUTROOM_GPU_HOST:-win4090}
scp -q gpu_setup.ps1 "$H:B:/AI/cutroom_gpu_setup.ps1"
ssh -o BatchMode=yes -o ServerAliveInterval=30 "$H" 'powershell -NoProfile -ExecutionPolicy Bypass -File B:\AI\cutroom_gpu_setup.ps1'
