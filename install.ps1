# Cutroom on Windows 10/11, one line in PowerShell:      irm <url>/install.ps1 | iex
# or from a copy of the source:                          powershell -ExecutionPolicy Bypass -File install.ps1
# Finds Python (offers winget), downloads ffmpeg, whisper.cpp, uv and the two speech models, runs `cutroom check` and installs
# the AI pack this PC can run (ai\setup.ps1: CUDA on an NVIDIA GPU with 6 GB+, a light CPU pack otherwise, or none, with the
# reason). Every download is pinned and checked by SHA-256. Everything goes into the prefix (and the library); nothing is
# installed system-wide and PATH is not changed: the launcher hands the tools to the Cutroom server process only. Safe to run
# again (finished downloads are kept). Piped there are no parameters, so the settings are environment variables:
#   CUTROOM_PREFIX     tools, source, AI models, Edge profile   (default %LOCALAPPDATA%\Cutroom)
#   CUTROOM_HOME       the library: media, projects, exports   (default Videos\Cutroom)
#   CUTROOM_SHORTCUTS  where the Start-menu shortcut goes      (default the Start menu's Programs)
#   CUTROOM_AI         auto | cuda | cpu | none                (default auto: what `cutroom check` picks)
#   CUTROOM_YES=1      no questions (Python through winget, the AI pack)
#   CUTROOM_SRC, CUTROOM_SRC_SHA256   the source .zip and its SHA-256, when not run from a copy of the source
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$SrcUrl = 'https://github.com/REPLACE-ME/cutroom/archive/refs/tags/v1.0.zip'  # the release this installer belongs to, and its
$SrcSha = 'REPLACE-ME'                                                      # SHA-256: both set when the source is published
$Prefix = if ($env:CUTROOM_PREFIX) { $env:CUTROOM_PREFIX } else { "$env:LOCALAPPDATA\Cutroom" }
$Library = if ($env:CUTROOM_HOME) { $env:CUTROOM_HOME } else { Join-Path ([Environment]::GetFolderPath('MyVideos')) 'Cutroom' }
$Shortcuts = if ($env:CUTROOM_SHORTCUTS) { $env:CUTROOM_SHORTCUTS } else { [Environment]::GetFolderPath('Programs') }
$Yes = $env:CUTROOM_YES -eq '1'
$bin = Join-Path $Prefix 'bin'
New-Item -ItemType Directory -Force $bin, (Join-Path $Library 'models') | Out-Null

function Get-Pinned($url, $file, $sha) { # download once; a file that doesn't match its SHA-256 is deleted, never used
  if ((Test-Path $file) -and (Get-FileHash $file -Algorithm SHA256).Hash -eq $sha) { return }
  Write-Host "Downloading $(Split-Path $file -Leaf)"
  & curl.exe -fsSL --retry 3 -o "$file.part" $url
  if ($LASTEXITCODE) { throw "Download failed: $url" }
  if ((Get-FileHash "$file.part" -Algorithm SHA256).Hash -ne $sha) { Remove-Item "$file.part"; throw "Checksum mismatch for $url" }
  Move-Item -Force "$file.part" $file
}

function Get-Tool($name, $url, $sha) { # a pinned zip unpacked into bin\<name>; the folder remembers the zip's hash
  $dir = Join-Path $bin $name
  if ((Test-Path "$dir\.sha256") -and (Get-Content "$dir\.sha256") -eq $sha) { return $dir }
  Get-Pinned $url "$dir.zip" $sha
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory $dir | Out-Null
  & "$env:SystemRoot\System32\tar.exe" -xf "$dir.zip" -C $dir
  if ($LASTEXITCODE) { throw "Could not unpack $dir.zip" }
  Set-Content "$dir\.sha256" $sha
  Remove-Item "$dir.zip"
  return $dir
}

function Find-Python { # the real python.exe of a 3.10+ install (the Microsoft Store stub answers nothing)
  $ask = "import sys; print(sys.executable if sys.version_info >= (3, 10) else '')"
  $runs = @({ & py -3 @args }, { & python @args }, { & "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe" @args })
  if ($env:CUTROOM_PYTHON) { $runs = @({ & $env:CUTROOM_PYTHON @args }) + $runs }
  foreach ($run in $runs) {
    try { $exe = & $run -c $ask 2>$null } catch { continue }
    if ($LASTEXITCODE -eq 0 -and $exe) { return "$exe".Trim() }
  }
}

function Confirm-Step($q) { $Yes -or ((Read-Host "$q [Y/n]") -notmatch '^[nN]') }

# 1. the source: this copy, or the release zip (pinned) unpacked into <prefix>\src; an update keeps the AI pack (ai\.venv, ai\vendor)
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'server.py'))) { $src = $PSScriptRoot } else {
  $url = if ($env:CUTROOM_SRC) { $env:CUTROOM_SRC } else { $SrcUrl }
  $sha = if ($env:CUTROOM_SRC_SHA256) { $env:CUTROOM_SRC_SHA256 } else { $SrcSha }
  if ("$url$sha" -match 'REPLACE-ME') { throw 'The Cutroom source is not published yet: set CUTROOM_SRC (a .zip of it) and CUTROOM_SRC_SHA256, then run this again.' }
  $src, $new = (Join-Path $Prefix 'src'), (Join-Path $Prefix 'src.new')
  Get-Pinned $url "$new.zip" $sha.ToUpper()
  if (Test-Path $new) { Remove-Item -Recurse -Force $new }
  New-Item -ItemType Directory $new | Out-Null
  & "$env:SystemRoot\System32\tar.exe" -xf "$new.zip" -C $new --strip-components 1  # (a GitHub zip holds one folder)
  if ($LASTEXITCODE -or -not (Test-Path "$new\server.py")) { throw "$url is not a Cutroom source zip" }
  foreach ($d in 'ai\.venv', 'ai\vendor') { if (Test-Path "$src\$d") { Move-Item "$src\$d" "$new\$d" } }
  if (Test-Path $src) { Remove-Item -Recurse -Force $src }
  Move-Item $new $src
  Remove-Item "$new.zip"
}
Write-Host "Source: $src"

# 2. Python 3.10 or newer (the server is the standard library only)
$py = Find-Python
if (-not $py) {
  if (-not (Confirm-Step 'Cutroom needs Python 3.10 or newer. Install Python 3.13 for this user with winget now?')) {
    throw 'Install Python 3.10 or newer (python.org, or: winget install Python.Python.3.13), then run the installer again.'
  }
  & winget install -e --id Python.Python.3.13 --scope user --accept-package-agreements --accept-source-agreements
  $py = Find-Python
  if (-not $py) { throw 'Python was not found after the winget install. Open a new terminal and run the installer again.' }
}
Write-Host "Python: $py"

# 3. ffmpeg 9.0.2, the gyan.dev "full" build (GPL; its GitHub mirror holds the versioned release)
$ff = Get-Tool 'ffmpeg-9.0.2-full_build' 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip' `
  '759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b'
$ffBin = Join-Path $ff 'ffmpeg-9.0.2-full_build\bin'

# 4. whisper.cpp 1.9.5 (release b5454, the same commit): the CUDA build when an NVIDIA driver for CUDA 12.4+ is there, else CPU (OpenBLAS)
$cuda = $null
try { if (((& nvidia-smi 2>$null) -join ' ') -match 'CUDA (UMD )?Version: (\d+\.\d+)') { $cuda = [version]$matches[2] } } catch { } # 'CUDA UMD Version' from driver 6xx
$wUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454'
$flavor = if ($cuda -and $cuda -ge [version]'12.4') { 'CUDA' } else { 'CPU' }
if ($flavor -eq 'CUDA') {
  $wh = Get-Tool 'whisper-1.9.5-cuda12' "$wUrl/whisper-bin-win-cuda-12.4.0-x64.zip" 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a'
} else {
  $wh = Get-Tool 'whisper-1.9.5-cpu' "$wUrl/whisper-blas-bin-x64.zip" 'b1158bd10edf92c9799149a6fc5d3e58da3f495241d6fb3423088130e88ffbf3'
}
$whBin = Join-Path $wh 'Release'

# 5. uv 0.13.6 (Astral, MIT/Apache-2.0): builds the AI pack's Python environment (ai\setup.ps1)
$uv = Join-Path (Get-Tool 'uv-0.13.6' 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip' `
  'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f') 'uv.exe'

# 6. the speech models, as install.sh: Whisper large-v3-turbo q5_0 (MIT, 574 MB) and Silero VAD (MIT, 1 MB)
Get-Pinned 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' `
  (Join-Path $Library 'models\ggml-large-v3-turbo-q5_0.bin') '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
Get-Pinned 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' `
  (Join-Path $Library 'models\ggml-silero-v5.1.2.bin') '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'

# 7. the launcher's settings: read by cutroom.ps1 and passed to the server process as environment, nothing system-wide.
#    HF_HOME: the AI models' Hugging Face cache lives in the prefix too, so removing the prefix removes them.
$cfg = [ordered]@{ CUTROOM_PYTHON = $py; CUTROOM_HOME = $Library; CUTROOM_FFMPEG_DIR = $ffBin; CUTROOM_WHISPER = (Join-Path $whBin 'whisper-cli.exe')
                   CUTROOM_PATH = "$ffBin;$whBin"; HF_HOME = (Join-Path $Prefix 'hf') }
Set-Content (Join-Path $Prefix 'cutroom.env') -Encoding UTF8 -Value @($cfg.Keys | ForEach-Object { "$_=$($cfg[$_])" })

# 8. cutroom check, and the AI pack it picks; the settings above go to these child processes only and are put back after
$keep = @{}
foreach ($k in @($cfg.Keys) + 'PATH', 'CUTROOM_UV', 'CUTROOM_PREFIX', 'UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR') { $keep[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
try {
  foreach ($k in $cfg.Keys) { Set-Item "env:$k" $cfg[$k] }
  $env:PATH = "$ffBin;$whBin;$env:PATH"
  $env:CUTROOM_UV = $uv
  $env:CUTROOM_PREFIX = $Prefix
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $Prefix 'python'  # uv's own Python for the AI pack (when this PC has no 3.12) and
  $env:UV_CACHE_DIR = Join-Path $Prefix 'uv-cache'          # its cache stay in the prefix too
  $ErrorActionPreference = 'Continue'
  $report = & $py -X utf8 -I (Join-Path $src 'server.py') --check
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -or -not ($report -match '^pack: ')) { throw "cutroom check failed: $($report -join "`n")" }
  $report | Where-Object { $_ -notmatch '^pack: ' } | ForEach-Object { Write-Host $_ }
  $pack = ($report -match '^pack: ')[-1].Substring(6).Trim()
  $size = @{ cuda = '~6.5 GB to download, ~9 GB on disk'; cpu = '~1.3 GB to download, ~2.5 GB on disk' }[$pack]  # (as server.py's AI_PACKS)
  if ($pack -eq 'none') {
    Write-Host 'No AI pack for this PC (the reason is above). The editor, captions and exports work without it.'
  } elseif (Confirm-Step "Install the $($pack.ToUpper()) AI pack now ($size, into $src\ai and $Prefix)?") {
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $src 'ai\setup.ps1') $pack
    if ($LASTEXITCODE) { throw "The AI pack did not install (ai\setup.ps1 $pack). Run the installer again to retry; finished downloads are kept." }
  } else {
    Write-Host "Skipped. Later: run the installer again, or: powershell -ExecutionPolicy Bypass -File `"$src\ai\setup.ps1`" $pack"
  }
} finally {
  foreach ($k in $keep.Keys) { [Environment]::SetEnvironmentVariable($k, $keep[$k], 'Process') }
}

# 9. a Start-menu shortcut (no console window)
New-Item -ItemType Directory -Force $Shortcuts | Out-Null
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $Shortcuts 'Cutroom.lnk'))
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$src\cutroom.ps1`" -Prefix `"$Prefix`""
$lnk.WorkingDirectory = $src
$lnk.Description = 'Cutroom video editor'
$lnk.Save()

# check: the tools run (whisper-cli prints its help on stderr, which Windows PowerShell 5.1 would turn into an error under 'Stop')
$ErrorActionPreference = 'Continue'
Write-Host "ffmpeg: $((& (Join-Path $ffBin 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1))"
& (Join-Path $whBin 'whisper-cli.exe') --help *> $null
Write-Host "whisper.cpp: $(if ($LASTEXITCODE -eq 0) { 'runs' } else { "exit code $LASTEXITCODE" }) ($flavor$(if ($cuda) { ", the driver supports CUDA $cuda" }))"
Write-Host "Library: $Library"
Write-Host "Done. Start Cutroom from the Start menu, or run `"$src\cutroom.cmd`". This computer's profile: `"$src\cutroom.cmd`" check"
}
