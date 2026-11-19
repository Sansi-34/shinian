# Stage review E2E one-shot runner: starts an isolated server + fake model, runs the E2E, cleans up.
param(
  [int]$Port = 3200,
  [string]$Base = "http://127.0.0.1:$Port"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$db = Join-Path $root "db\e2e-review.sqlite"
$key = Join-Path $root "db\e2e-review-master.key"
$srvLog = Join-Path $root "db\e2e-review-server.log"
$fakeLog = Join-Path $root "db\fake-model.log"

function Stop-Tree($proc) {
  if (-not $proc) { return }
  & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
}

$srv = $null
$fake = $null
$code = 1
try {
  $env:PORT = "$Port"
  $env:DATABASE_URL = $db
  $env:SHINIAN_MASTER_KEY_FILE = $key
  $env:NODE_ENV = "production"
  $srv = Start-Process -FilePath "node" -ArgumentList "node_modules/tsx/dist/cli.mjs","src/server/index.ts" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $srvLog -RedirectStandardError "$srvLog.err" -PassThru
  $fake = Start-Process -FilePath "python" -ArgumentList "scripts/fake_model_server.py" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $fakeLog -RedirectStandardError "$fakeLog.err" -PassThru

  $deadline = (Get-Date).AddSeconds(25)
  do {
    Start-Sleep -Milliseconds 500
    $srvOk = $false
    $fakeOk = $false
    try { (Invoke-WebRequest "$Base/api/session/check" -UseBasicParsing -TimeoutSec 2) | Out-Null; $srvOk = $true } catch { if ($_.Exception.Response) { $srvOk = $true } }
    try { (Invoke-WebRequest "http://127.0.0.1:3501/__health" -UseBasicParsing -TimeoutSec 2) | Out-Null; $fakeOk = $true } catch { }
  } while ((Get-Date) -lt $deadline -and (-not $srvOk -or -not $fakeOk))

  if (-not $srvOk) { throw "isolated server did not start on $Base (see $srvLog)" }
  if (-not $fakeOk) { throw "fake model server did not start on 3501 (see $fakeLog)" }
  Write-Output "isolated server and fake model ready ($Base / 127.0.0.1:3501)"

  $env:SHINIAN_BASE = $Base
  & node (Join-Path $root "scripts\e2e_review.mjs")
  $code = $LASTEXITCODE
} finally {
  Stop-Tree $srv
  Stop-Tree $fake
}
exit $code
