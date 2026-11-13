# Cutroom, first-time setup on Windows 10/11: finds Python (offers winget), downloads ffmpeg and whisper.cpp into
# %LOCALAPPDATA%\Cutroom\bin and the two speech models into the library, every file pinned and checked by SHA-256, writes
# the launcher's settings (cutroom.env) and a Start-menu shortcut. Nothing is installed system-wide and PATH is not changed:
# the launcher hands the tools to the Cutroom server process only. Safe to run again (finished downloads are kept).
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Prefix <tools folder>] [-Library <library folder>] [-Shortcuts <folder>] [-Yes]
param(
  [string]$Prefix = "$env:LOCALAPPDATA\Cutroom",
  [string]$Library = $(if ($env:CUTROOM_HOME) { $env:CUTROOM_HOME } else { Join-Path ([Environment]::GetFolderPath('MyVideos')) 'Cutroom' }),
  [string]$Shortcuts = [Environment]::GetFolderPath('Programs'),
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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

# 1. Python 3.10 or newer (the server is the standard library only)
$py = Find-Python
if (-not $py) {
  $go = $Yes -or ((Read-Host 'Cutroom needs Python 3.10 or newer. Install Python 3.13 with winget now? [Y/n]') -notmatch '^[nN]')
  if (-not $go) { throw 'Install Python 3.10 or newer (python.org, or: winget install Python.Python.3.13), then run install.ps1 again.' }
  & winget install -e --id Python.Python.3.13 --scope user --accept-package-agreements --accept-source-agreements
  $py = Find-Python
  if (-not $py) { throw 'Python was not found after the winget install. Open a new terminal and run install.ps1 again.' }
}
Write-Host "Python: $py"

# 2. ffmpeg 9.0.2, the gyan.dev "full" build (GPL; its GitHub mirror holds the versioned release)
$ff = Get-Tool 'ffmpeg-9.0.2-full_build' 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip' `
  '759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b'
$ffBin = Join-Path $ff 'ffmpeg-9.0.2-full_build\bin'

# 3. whisper.cpp 1.9.5 (release b5454, the same commit): the CUDA build when an NVIDIA driver for CUDA 12.4+ is there, else CPU (OpenBLAS)
$cuda = $null
try { if (((& nvidia-smi 2>$null) -join ' ') -match 'CUDA Version: (\d+\.\d+)') { $cuda = [version]$matches[1] } } catch { }
$wUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454'
$flavor = if ($cuda -and $cuda -ge [version]'12.4') { 'CUDA' } else { 'CPU' }
if ($flavor -eq 'CUDA') {
  $wh = Get-Tool 'whisper-1.9.5-cuda12' "$wUrl/whisper-bin-win-cuda-12.4.0-x64.zip" 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a'
} else {
  $wh = Get-Tool 'whisper-1.9.5-cpu' "$wUrl/whisper-blas-bin-x64.zip" 'b1158bd10edf92c9799149a6fc5d3e58da3f495241d6fb3423088130e88ffbf3'
}
$whBin = Join-Path $wh 'Release'

# 4. the speech models, as install.sh: Whisper large-v3-turbo q5_0 (MIT, 574 MB) and Silero VAD (MIT, 1 MB)
Get-Pinned 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' `
  (Join-Path $Library 'models\ggml-large-v3-turbo-q5_0.bin') '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
Get-Pinned 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' `
  (Join-Path $Library 'models\ggml-silero-v5.1.2.bin') '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'

# 5. the launcher's settings: read by cutroom.ps1 and passed to the server process as environment, nothing system-wide
Set-Content (Join-Path $Prefix 'cutroom.env') -Encoding UTF8 -Value @(
  "CUTROOM_PYTHON=$py", "CUTROOM_HOME=$Library", "CUTROOM_FFMPEG_DIR=$ffBin",
  "CUTROOM_WHISPER=$(Join-Path $whBin 'whisper-cli.exe')", "CUTROOM_PATH=$ffBin;$whBin")

# 6. a Start-menu shortcut (no console window)
New-Item -ItemType Directory -Force $Shortcuts | Out-Null
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $Shortcuts 'Cutroom.lnk'))
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\cutroom.ps1`" -Prefix `"$Prefix`""
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.Description = 'Cutroom video editor'
$lnk.Save()

# check: the tools run (whisper-cli prints its help on stderr, which Windows PowerShell 5.1 would turn into an error under 'Stop')
$ErrorActionPreference = 'Continue'
Write-Host "ffmpeg: $((& (Join-Path $ffBin 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1))"
& (Join-Path $whBin 'whisper-cli.exe') --help *> $null
Write-Host "whisper.cpp: $(if ($LASTEXITCODE -eq 0) { 'runs' } else { "exit code $LASTEXITCODE" }) ($flavor$(if ($cuda) { ", the driver supports CUDA $cuda" }))"
Write-Host "Library: $Library"
Write-Host 'Done. Start Cutroom from the Start menu, or run cutroom.cmd.'
