#!/bin/sh
# Lip sync and talking photos run on an NVIDIA GPU PC (18-24 GB) you name with CUTROOM_GPU_HOST, an ~/.ssh/config alias.
# This copies ai/gpu_setup.ps1 there and runs it: LatentSync 1.6 in its own venv (lip sync of real footage) and the Wan 2.2 S2V
# weights in its ComfyUI (talking photos); ~30 GB, every weight SHA-256 checked, licences listed in gpu_setup.ps1.
set -eu
cd "$(dirname "$0")"
H=${CUTROOM_GPU_HOST:?set CUTROOM_GPU_HOST to the GPU PC (an ~/.ssh/config alias)}
scp -q gpu_setup.ps1 "$H:B:/AI/cutroom_gpu_setup.ps1"
ssh -o BatchMode=yes -o ServerAliveInterval=30 "$H" 'powershell -NoProfile -ExecutionPolicy Bypass -File B:\AI\cutroom_gpu_setup.ps1'
