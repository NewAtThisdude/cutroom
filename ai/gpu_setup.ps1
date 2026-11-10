# Cutroom on the RTX 4090 PC: talking photos and lip sync = Wan 2.2 S2V 14B fp8 (Apache-2.0) with its wav2vec2 audio encoder and
# lightx2v's 4-step LoRA (Apache-2.0), into ComfyUI's models (ComfyUI 0.26+ has the S2V nodes built in). ~18 GB, once.
# Pinned: the Hugging Face revision and every file's SHA-256; safe to run again. Run from the Mac: ai/gpu_setup.sh
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$M = 'B:\AI\ComfyUI_windows_portable\ComfyUI\models'
$W = 'https://huggingface.co/Comfy-Org/Wan-2.2/resolve/ee6f4a40737a995bf5818954cfce6d59443b0f04/split_files'
foreach ($f in @(@('audio_encoders\wav2vec2_large_english_fp16.safetensors', 'f0017a43ea57ef6b3d4866be607844bbd8cada6d30966f7d70044ed0d63d3f9e'),
                 @('loras\wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors', '698321cb86bd30c4af06c9b84e656a1048c8cb54e06d50694536fb5de37fde41'),
                 @('diffusion_models\wan2.2_s2v_14B_fp8_scaled.safetensors', '140e75af5534ac3d91e710d9df756f7032addd64b341ba2c1c70e3e6da9aa216'))) {
  $out = "$M\$($f[0])"
  if (-not (Test-Path $out)) { & curl.exe -sSfL -o "$out.part" "$W/$($f[0].Replace('\', '/'))"; Move-Item "$out.part" $out }
  $h = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($h -ne $f[1].ToUpper()) { Remove-Item $out; throw "checksum mismatch $out" }
  Write-Output "ok $out"
}
