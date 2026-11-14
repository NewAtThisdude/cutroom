# Cutroom's AI pack on a Windows PC: the PyTorch builds of the models the Mac runs on MLX / MPS, sized by `cutroom check`
# (install.ps1 runs this with the pack it picked; by hand: powershell -ExecutionPolicy Bypass -File ai\setup.ps1 cuda|cpu).
#   cuda  an NVIDIA GPU (Turing or newer, 6 GB+, a driver for CUDA 13.2): PyTorch 2.14.1 for CUDA 13.2. ~6.5 GB to download, ~9 GB on disk.
#         Kokoro-82M voices (hexgrad, Apache-2.0), Demucs htdemucs (Meta, MIT), WavLM speaker labels (Microsoft, CC BY-SA 3.0),
#         SAM 2.1 small (Meta, Apache-2.0) + ProPainter (S-Lab licence: personal / non-commercial use) for object removal and
#         cut-outs, RIFE 4.25 (MIT), Real-ESRGAN x4v3 (BSD-3), Depth Anything V2 Small (Apache-2.0), MusicGen small (Meta;
#         weights CC-BY-NC 4.0: personal use), OpenCV, pyworld (voice characters).
#   cpu   any other PC with 8 GB+: PyTorch 2.14.1 for the CPU. ~1.3 GB to download, ~2.5 GB on disk. Kokoro, Demucs (slow), WavLM, OpenCV, pyworld: the jobs
#         server.py's AI_BUDGET has CPU rows for; the GPU-only tools stay off and say so.
# No Windows equivalent yet (they say so in the AI tab): Chatterbox voice clone and dubbing (its PyTorch package pins torch
# 2.6, which has no CUDA 13 build), Z-Image image generation (mflux / MLX only here), and the Apple Vision tools (remove
# background, find faces, retouch). Captions are whisper.cpp (install.ps1). Lip sync / talking photo / AI video: gpu_setup.ps1.
# Pinned: uv's lock of every package with its SHA-256 (win-cuda.lock / win-cpu.lock, installed with --require-hashes), source
# tarballs and weights by SHA-256, Hugging Face models by revision with the weight file checked. Everything goes into this
# folder (.venv, vendor), the library's packs and the Hugging Face cache (HF_HOME: install.ps1 puts it in its prefix); no admin,
# no PATH or system change. Safe to run again.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pack = if ($args.Count) { "$($args[0])" } else { 'cpu' }
if ($pack -notin 'cuda', 'cpu') { throw "usage: ai\setup.ps1 cuda|cpu (not '$pack')" }
$ai = $PSScriptRoot
$uv = if ($env:CUTROOM_UV) { $env:CUTROOM_UV } else { 'uv' }
$py = "$ai\.venv\Scripts\python.exe"
$env:PYTHONPATH = $null

function Get-Pinned($url, $out, $sha) { # once; a file that doesn't match its SHA-256 is deleted, never used
  if ((Test-Path $out) -and (Get-FileHash $out -Algorithm SHA256).Hash -eq $sha) { return }
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  Write-Host "Downloading $(Split-Path $out -Leaf)"
  & curl.exe -fsSL --retry 3 -o "$out.part" $url
  if ($LASTEXITCODE) { throw "Download failed: $url" }
  if ((Get-FileHash "$out.part" -Algorithm SHA256).Hash -ne $sha) { Remove-Item "$out.part"; throw "Checksum mismatch for $url" }
  Move-Item -Force "$out.part" $out
}

function Get-Source($name, $url, $sha, $exclude) { # a pinned GitHub tarball unpacked into vendor\<name> (marked with its hash)
  $dir = "$ai\vendor\$name"
  if ((Test-Path "$dir\.sha256") -and (Get-Content "$dir\.sha256") -eq $sha) { return }
  Get-Pinned $url "$ai\vendor\$name.tar.gz" $sha
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory $dir | Out-Null
  & "$env:SystemRoot\System32\tar.exe" -xzf "$ai\vendor\$name.tar.gz" -C $dir --strip-components 1 @(if ($exclude) { '--exclude', $exclude })
  if ($LASTEXITCODE) { throw "Could not unpack $name" }
  Set-Content "$dir\.sha256" $sha
  Remove-Item "$ai\vendor\$name.tar.gz"
}

# 1. Python 3.12 (Kokoro's G2P needs < 3.13; uv fetches its own checked build when the PC has none) and the locked packages
if (-not (Test-Path $py)) { & $uv venv --python 3.12 "$ai\.venv"; if ($LASTEXITCODE) { throw 'uv venv failed' } }
$index = if ($pack -eq 'cuda') { 'https://download.pytorch.org/whl/cu132' } else { 'https://download.pytorch.org/whl/cpu' }
& $uv pip install --python $py --require-hashes --no-cache --link-mode copy -r "$ai\win-$pack.lock" `
  --index-url https://pypi.org/simple --extra-index-url $index --index-strategy unsafe-best-match
if ($LASTEXITCODE) { throw 'installing the AI packages failed' }

# 2. Hugging Face models at pinned revisions, the weight file checked; refs/main is set to that revision so the code that asks
#    for "main" (Kokoro, Demucs, MusicGen) finds this copy offline (the server runs the AI with HF_HUB_OFFLINE=1)
$hub = @'
import hashlib, pathlib, sys
from huggingface_hub import constants, snapshot_download
PINS = [  # repo, revision, files, the weight file, its SHA-256, packs
    ('hexgrad/Kokoro-82M', 'f3ff3571791e39611d31c381e3a41a3af07b4987', ['config.json', 'kokoro-v1_0.pth', 'voices/*.pt'], 'kokoro-v1_0.pth',
     '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4', 'cuda cpu'),
    ('adefossez/HTDemucs', 'cbc8a9b1a87023b7fd74e7b3412e6321c0eab003', ['htdemucs.yaml', '955717e8.safetensors'], '955717e8.safetensors',
     'd9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd', 'cuda cpu'),
    ('microsoft/wavlm-base-plus-sv', 'feb593a6c23c1cc3d9510425c29b0a14d2b07b1e', ['*.json', 'pytorch_model.bin'], 'pytorch_model.bin',
     'e906bce2fa42fb497a1d1a9ecf81548adb7e03b12a5644e32d2f42f0d6500fad', 'cuda cpu'),
    ('depth-anything/Depth-Anything-V2-Small-hf', '5426e4f0f36572d16453bbda7a8389317b1bef99', ['*.json', 'model.safetensors'], 'model.safetensors',
     '3152477ce0d8d6978d76b995120de97cb5b928701fd0f817769f59e249a16b70', 'cuda'),
    ('facebook/musicgen-small', '4c8334b02c6ec4e8664a91979669a501ec497792', ['*.json', 'model.safetensors', 'spiece.model'], 'model.safetensors',
     '1bdc99d43eb6c775967df24b65b0a9f847c0907e95664698d93b5a1c35f5090d', 'cuda')]
for repo, rev, pats, f, sha, packs in PINS:
    if sys.argv[1] not in packs.split():
        continue
    d = snapshot_download(repo, revision=rev, allow_patterns=pats)
    h = hashlib.sha256()
    with open(f'{d}/{f}', 'rb') as fh:
        for b in iter(lambda: fh.read(1 << 24), b''):
            h.update(b)
    assert h.hexdigest() == sha, (repo, f, h.hexdigest())
    ref = pathlib.Path(constants.HF_HUB_CACHE) / ('models--' + repo.replace('/', '--')) / 'refs' / 'main'
    ref.parent.mkdir(parents=True, exist_ok=True)
    ref.write_text(rev)
    if repo == 'microsoft/wavlm-base-plus-sv':  # speaker labels (ai/diarize.py) read it from vendor/
        snapshot_download(repo, revision=rev, allow_patterns=pats, local_dir=str(pathlib.Path(sys.argv[2]) / 'vendor' / 'wavlm-base-plus-sv'))
    print('ok', repo)
'@
$hub | & $py -X utf8 -I - $pack $ai
if ($LASTEXITCODE) { throw 'downloading the models failed' }

# 3. the GPU tools' code and weights (CUDA pack only: they have no CPU rows in AI_BUDGET)
if ($pack -eq 'cuda') {
  # SAM 2 and ProPainter from their official repos at the same commits as setup.sh (the 4 legacy config symlinks left out:
  # Windows can't make them without admin, and Cutroom loads configs/sam2.1). SAM 2 is used from its folder (a .pth file):
  # built without its CUDA extension, as on the Mac, it is plain Python.
  Get-Source 'sam2' 'https://codeload.github.com/facebookresearch/sam2/tar.gz/2b90b9f5ceec907a1c18123530e92e794ad901a4' `
    '1F2FBFAD3FFA38110368ABAC76C6EF9DF9C282A66D5C2807BC94ABF4D2FB30F8' '*/sam2/sam2_hiera_*.yaml'
  Set-Content "$ai\.venv\Lib\site-packages\cutroom-sam2.pth" "$ai\vendor\sam2"
  Get-Pinned 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt' "$ai\vendor\sam2\checkpoints\sam2.1_hiera_small.pt" `
    '6D1AA6F30DE5C92224F8172114DE081D104BBD23DD9DC5C58996F0CAD5DC4D38'
  Get-Source 'ProPainter' 'https://codeload.github.com/sczhou/ProPainter/tar.gz/326782529a63d997cab80ab21439b92ed422b3d3' `
    '3FADBEF7E6D2C1F32FEC026AE71BE2EC436D75F83A4B5952AC03AB491BCB9707'
  $PP = 'https://github.com/sczhou/ProPainter/releases/download/v0.1.0'
  Get-Pinned "$PP/ProPainter.pth" "$ai\vendor\ProPainter\weights\ProPainter.pth" '12C070C4B48F374C91D8A2A17851140B85C159621080989F9E191BBC18BD6591'
  Get-Pinned "$PP/recurrent_flow_completion.pth" "$ai\vendor\ProPainter\weights\recurrent_flow_completion.pth" '22939A1A7900DA878DBE1CCD011D646B1BFB30B8290039D8FF0E0C2FEFBFD283'
  Get-Pinned "$PP/raft-things.pth" "$ai\vendor\ProPainter\weights\raft-things.pth" 'FCFA4125D6418F4DE95D84AEC20A3C5F4E205101715A79F193243C186AC9A7E1'
  # AI enhance: RIFE 4.25 (HolyWu's vs-rife model file, pinned commit), Real-ESRGAN x4v3 and its -wdn twin
  $VR = 'https://raw.githubusercontent.com/HolyWu/vs-rife/3488617283db7c428a83ba4a19382285da698b6a'
  Get-Pinned "$VR/vsrife/IFNet_HDv3_v4_25.py" "$ai\vendor\enhance\rife\IFNet_HDv3_v4_25.py" 'FAF8E6EF4579B1049011A8E4139FB4E790EC220BD6ECAB75F5ACB8D01D1456B2'
  Get-Pinned "$VR/vsrife/warplayer.py" "$ai\vendor\enhance\rife\warplayer.py" 'F17B5AEA73676C059B4C155852217C954D5B4EB19CC08EFF40B43EDD6055AB73'
  Get-Pinned "$VR/LICENSE" "$ai\vendor\enhance\rife\LICENSE" 'AEA942CAF766B16E6EF0B26E033FA92C0DEA3124F6F7AD4A18CA1FB43E010D40'
  Set-Content "$ai\vendor\enhance\rife\__init__.py" ''
  Get-Pinned 'https://github.com/HolyWu/vs-rife/releases/download/model/flownet_v4.25.pkl' "$ai\vendor\enhance\flownet_v4.25.pkl" '6615790EFD627772917205DB291F51CD392528A157ECBB2ECAEEC3BFF8EB6DE2'
  $ES = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0'
  Get-Pinned "$ES/realesr-general-x4v3.pth" "$ai\vendor\enhance\realesr-general-x4v3.pth" '8DC7EDB9AC80CCDC30C3A5DCA6616509367F05FBC184AD95B731F05BECE96292'
  Get-Pinned "$ES/realesr-general-wdn-x4v3.pth" "$ai\vendor\enhance\realesr-general-wdn-x4v3.pth" '1641F8C4464B9F097C9FDDA5589273713F67CF59F3D909E0BD688F0CEE269DCA'
  # MusicGen's half-precision copy (vendor\musicgen-small-fp16), made once on the GPU: music.py loads it straight onto it
  $env:HF_HUB_OFFLINE = '1'
  & $py -X utf8 -I -c "import sys; sys.path.insert(0, r'$ai'); import music, torch; music.load(torch.device('cuda'))"
  $env:HF_HUB_OFFLINE = $null
  if ($LASTEXITCODE) { throw 'MusicGen did not load on the GPU' }
}

# 4. checks: the packs' device, then one sentence through the AI worker exactly as the server asks for it (offline)
$dev = (& $py -X utf8 -I -c "import torch, cv2, demucs, kokoro, pyworld; print('cuda' if torch.cuda.is_available() else 'cpu')" | Select-Object -Last 1)
if ($pack -eq 'cuda' -and $dev -ne 'cuda') { throw 'PyTorch does not see the NVIDIA GPU (update the driver: CUDA 13.2+, version 595 or newer)' }
$wav = Join-Path ([IO.Path]::GetTempPath()) "cutroom-voice-check-$PID.wav"
$env:HF_HUB_OFFLINE = '1'
$ErrorActionPreference = 'Continue'  # Kokoro's warnings on stderr are not failures (Windows PowerShell would stop on them)
$said = '{"id": 1, "op": "voice", "text": "Cutroom voices are ready.", "voice": "af_heart", "speed": 1.0, "out": "' + $wav.Replace('\', '/') + '"}' |
  & $py -X utf8 -I "$ai\worker.py" 0
$env:HF_HUB_OFFLINE = $null
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $wav) -or "$said" -notmatch '"result"') { throw "Kokoro did not speak: $said" }
Remove-Item $wav
# the CC0 sound and music library into the library's packs folder (not AI, but the same one-time setup; ~100 MB)
$sys = if ($env:CUTROOM_PYTHON) { $env:CUTROOM_PYTHON } else { 'python' }
& $sys -X utf8 -I "$ai\..\server.py" --packs
Write-Host "AI pack ready: $pack (PyTorch on $dev)"
