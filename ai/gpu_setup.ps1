# Cutroom on the RTX 4090 PC, two models. Pinned: commits, Hugging Face revisions, package versions and every weight file's
# SHA-256; safe to run again. Run from the Mac: ai/gpu_setup.sh (it copies this file and runs it there).
#
# 1. Talking photo (a still re-animated to speech) = Wan 2.2 S2V 14B fp8 (Wan-AI, Apache-2.0) with its audio encoder
#    wav2vec2_large_english_fp16 (= jonatasgrosman/wav2vec2-large-xlsr-53-english, Apache-2.0, fine-tuned from Meta's XLSR-53;
#    repackaged by Comfy-Org, Apache-2.0) and lightx2v's 4-step LoRA (Apache-2.0), into ComfyUI's models (ComfyUI 0.26+ has the
#    S2V nodes built in). ~18 GB.
# 2. Lip sync of real footage = LatentSync 1.6 (ByteDance; code Apache-2.0, weights CreativeML OpenRAIL++-M: use restrictions,
#    no illegal / harmful / deceptive uses) in its own venv at B:\AI\LatentSync, with whisper tiny (OpenAI, MIT), the SD VAE
#    ft-MSE (Stability AI, MIT) and InsightFace buffalo_l's face detector + 106-point landmarks (InsightFace: the models are for
#    non-commercial research use only; Cutroom is a personal tool). ~6 GB of weights + ~5 GB of packages.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-Pinned($url, $out, $sha) {
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  if (-not (Test-Path $out)) { & curl.exe -sSfL -o "$out.part" $url; if ($LASTEXITCODE) { throw "download failed $url" }; Move-Item "$out.part" $out }
  $h = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($h -ne $sha.ToUpper()) { Remove-Item $out; throw "checksum mismatch $out" }
  Write-Output "ok $out"
}

# ---------- 1. Wan 2.2 S2V into ComfyUI ----------
$M = 'B:\AI\ComfyUI_windows_portable\ComfyUI\models'
$W = 'https://huggingface.co/Comfy-Org/Wan-2.2/resolve/ee6f4a40737a995bf5818954cfce6d59443b0f04/split_files'
foreach ($f in @(@('audio_encoders\wav2vec2_large_english_fp16.safetensors', 'f0017a43ea57ef6b3d4866be607844bbd8cada6d30966f7d70044ed0d63d3f9e'),
                 @('loras\wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors', '698321cb86bd30c4af06c9b84e656a1048c8cb54e06d50694536fb5de37fde41'),
                 @('diffusion_models\wan2.2_s2v_14B_fp8_scaled.safetensors', '140e75af5534ac3d91e710d9df756f7032addd64b341ba2c1c70e3e6da9aa216'))) {
  Get-Pinned "$W/$($f[0].Replace('\', '/'))" "$M\$($f[0])" $f[1]
}

# ---------- 2. LatentSync 1.6 ----------
$LS = 'B:\AI\LatentSync'
$COMMIT = 'a229c3948406bc2cf6eaf4873e662e70c6a04746'  # bytedance/LatentSync main, 2025-06-20
if (-not (Test-Path "$LS\latentsync")) {
  $tgz = "B:\AI\LatentSync-$COMMIT.tar.gz"
  Get-Pinned "https://codeload.github.com/bytedance/LatentSync/tar.gz/$COMMIT" $tgz '49e285678f27b7ac84136f2e47887284c2572771a3ca29d64df003caeff8d956'
  & tar.exe -xzf $tgz -C 'B:\AI'
  Move-Item "B:\AI\LatentSync-$COMMIT" $LS
}
$py = "$LS\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { & uv venv --python 3.10.13 "$LS\.venv"; if ($LASTEXITCODE) { throw 'uv venv failed' } }
# LatentSync's requirements.txt, inference only (no gradio / training / mediapipe), same versions; torch for CUDA 12.1
& uv pip install --python $py --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cu121 `
  torch==2.5.1+cu121 torchvision==0.20.1+cu121 diffusers==0.32.2 transformers==4.48.0 accelerate==0.26.1 einops==0.7.0 omegaconf==2.3.0 `
  opencv-python==4.9.0.80 imageio==2.31.1 imageio-ffmpeg==0.5.1 decord==0.6.0 ffmpeg-python==0.2.0 kornia==0.8.0 numpy==1.26.4 `
  huggingface-hub==0.30.2 onnxruntime-gpu==1.21.0 DeepCache==0.1.1 soundfile==0.13.1 matplotlib==3.9.4 more-itertools==10.6.0 regex==2024.11.6 `
  tqdm==4.67.1 packaging==24.2 insightface==0.7.3
if ($LASTEXITCODE) { throw 'pip install failed' }
Copy-Item (& $py -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())') "$LS\.venv\Scripts\ffmpeg.exe" -Force  # LatentSync calls "ffmpeg"
$H = 'https://huggingface.co/ByteDance/LatentSync-1.6/resolve/c42c7e6c8e9c213626389fa7d9a3c444b8536353'
Get-Pinned "$H/latentsync_unet.pt" "$LS\checkpoints\latentsync_unet.pt" '0a478e89eb660f82da4c35dbdde8a5adfb27f99d1b4e50edd03729e1e98316d3'
Get-Pinned "$H/whisper/tiny.pt" "$LS\checkpoints\whisper\tiny.pt" '65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9'
$V = 'https://huggingface.co/stabilityai/sd-vae-ft-mse/resolve/31f26fdeee1355a5c34592e401dd41e45d25a493'
Get-Pinned "$V/config.json" "$LS\checkpoints\sd-vae-ft-mse\config.json" '92d3dfb746fca211a2c9e019e285f8597412211728dce3c5bcf4eda0f2d62e7e'
Get-Pinned "$V/diffusion_pytorch_model.safetensors" "$LS\checkpoints\sd-vae-ft-mse\diffusion_pytorch_model.safetensors" 'a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815'
$B = "$LS\checkpoints\auxiliary\models\buffalo_l"  # only the detector and the 106-point landmarks (FaceAnalysis loads what is there)
if (-not ((Test-Path "$B\det_10g.onnx") -and (Test-Path "$B\2d106det.onnx"))) {
  Get-Pinned 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip' "B:\AI\buffalo_l.zip" '80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f'
  & tar.exe -xf 'B:\AI\buffalo_l.zip' -C (New-Item -ItemType Directory -Force $B).FullName det_10g.onnx 2d106det.onnx
}
foreach ($f in @(@('det_10g.onnx', '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91'), @('2d106det.onnx', 'f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf'))) {
  if ((Get-FileHash "$B\$($f[0])" -Algorithm SHA256).Hash -ne $f[1].ToUpper()) { Remove-Item "$B\$($f[0])"; throw "checksum mismatch $($f[0])" }
}
Write-Output 'LatentSync ready'
