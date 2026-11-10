#!/bin/sh
# Talking photos and lip sync run on the RTX 4090 PC (CUTROOM_GPU_HOST, an ~/.ssh/config alias, default win4090) in its ComfyUI.
# This copies ai/gpu_setup.ps1 there and runs it: the Wan 2.2 S2V weights (~18 GB, SHA-256 checked).
set -eu
cd "$(dirname "$0")"
H=${CUTROOM_GPU_HOST:-win4090}
scp -q gpu_setup.ps1 "$H:B:/AI/cutroom_gpu_setup.ps1"
ssh -o BatchMode=yes -o ServerAliveInterval=30 "$H" 'powershell -NoProfile -ExecutionPolicy Bypass -File B:\AI\cutroom_gpu_setup.ps1'
