# Cutroom on Windows: start the server if it isn't running (hidden, no console), then open the editor as an app window
# in Microsoft Edge (Chrome if there is no Edge), with its own profile so it behaves like an app. Started on demand, never
# at login. Settings come from <Prefix>\cutroom.env (written by install.ps1) and go to the server process only.
#   cutroom.cmd [-ServerOnly]       or: powershell -ExecutionPolicy Bypass -File cutroom.ps1 [-Prefix <folder>] [-ServerOnly]
param([string]$Prefix = "$env:LOCALAPPDATA\Cutroom", [switch]$ServerOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$cfg = Join-Path $Prefix 'cutroom.env'
if (Test-Path $cfg) { # KEY=VALUE lines; a variable already set in the environment wins
  foreach ($l in Get-Content $cfg) { if ($l -match '^(CUTROOM_\w+)=(.*)$' -and -not (Test-Path "env:$($matches[1])")) { Set-Item "env:$($matches[1])" $matches[2] } }
}
if ($env:CUTROOM_PATH) { $env:PATH = "$env:CUTROOM_PATH;$env:PATH" } # ffmpeg and whisper.cpp, for this process and the server it starts
$port = if ($env:CUTROOM_PORT) { $env:CUTROOM_PORT } else { '4610' }
$url = "http://127.0.0.1:$port/"
$lib = if ($env:CUTROOM_HOME) { $env:CUTROOM_HOME } else { Join-Path ([Environment]::GetFolderPath('MyVideos')) 'Cutroom' }
$env:CUTROOM_HOME = $lib

function Test-Up { try { (Invoke-WebRequest "${url}api/ping" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }

if (-not (Test-Up)) {
  $py = if ($env:CUTROOM_PYTHON) { $env:CUTROOM_PYTHON } else { 'python' }
  New-Item -ItemType Directory -Force $lib | Out-Null
  # -X utf8: file names, captions and ffmpeg's messages in UTF-8 (python -I ignores PYTHONUTF8); cmd appends both streams to the log
  Start-Process "$env:SystemRoot\System32\cmd.exe" -WindowStyle Hidden -WorkingDirectory $PSScriptRoot `
    -ArgumentList "/d /s /c `"`"$py`" -X utf8 -I `"$PSScriptRoot\server.py`" >> `"$lib\server.log`" 2>&1`""
  for ($i = 0; $i -lt 50 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Up)) { Write-Host "The Cutroom server did not answer on port $port. Its log: $lib\server.log"; exit 1 }
}
if ($ServerOnly) { exit 0 }

$app = @("--app=$url", '--no-first-run', '--no-default-browser-check')
try { Start-Process msedge -ArgumentList ($app + "--user-data-dir=`"$Prefix\edge`"") }
catch { Start-Process chrome -ArgumentList ($app + "--user-data-dir=`"$Prefix\chrome`"") }
