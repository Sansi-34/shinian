# Ask My Records E2E one-shot runner: starts an isolated server + fake model, runs the E2E, cleans up.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/run_e2e_ask.ps1
param(
  [int]$Port = 3201,
  [string]$Base = "http://127.0.0.1:$Port",
  [int]$FakePort = 3501
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$db = Join-Path $root "db\e2e-ask.sqlite"
$key = Join-Path $root "db\e2e-ask-master.key"
$srvLog = Join-Path $root "db\e2e-ask-server.log"
$fakeLog = Join-Path $root "db\e2e-ask-fake-model.log"
$fakePort = $FakePort

function Stop-Tree($proc) {
  if (-not $proc) { return }
  & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
}

# Refuse to reuse ports: this runner must own an isolated server + fake model.
$busy = @()
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $busy += $Port }
if (Get-NetTCPConnection -LocalPort $fakePort -State Listen -ErrorAction SilentlyContinue) { $busy += $fakePort }
if ($busy.Count -gt 0) {
  throw "port(s) $($busy -join ', ') already in use; stop them or pass -Port/-FakePort."
}

# Start from an empty isolated database every run.
foreach ($p in @($db, "$db-wal", "$db-shm", $key)) {
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}
if (Test-Path -LiteralPath $srvLog) { Remove-Item -LiteralPath $srvLog -Force }
if (Test-Path -LiteralPath "$srvLog.err") { Remove-Item -LiteralPath "$srvLog.err" -Force }
if (Test-Path -LiteralPath $fakeLog) { Remove-Item -LiteralPath $fakeLog -Force }
if (Test-Path -LiteralPath "$fakeLog.err") { Remove-Item -LiteralPath "$fakeLog.err" -Force }

$srv = $null
$fake = $null
$code = 1
try {
  $env:PORT = "$Port"
  $env:HOST = "127.0.0.1"
  $env:DATABASE_URL = $db
  $env:SHINIAN_MASTER_KEY_FILE = $key
  $env:SHINIAN_AI_TIMEOUT_MS = "1200"
  $env:SHINIAN_AI_TEST_TIMEOUT_MS = "800"
  $env:SHINIAN_FAKE_PORT = "$fakePort"
  $env:NODE_ENV = "production"
  $srv = Start-Process -FilePath "node" -ArgumentList "node_modules/tsx/dist/cli.mjs","src/server/index.ts" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $srvLog -RedirectStandardError "$srvLog.err" -PassThru
  $fake = Start-Process -FilePath "python" -ArgumentList "scripts/fake_model_server.py" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $fakeLog -RedirectStandardError "$fakeLog.err" -PassThru

  $deadline = (Get-Date).AddSeconds(30)
  $srvOk = $false
  $fakeOk = $false
  do {
    Start-Sleep -Milliseconds 500
    $srvOk = $false
    $fakeOk = $false
    try { (Invoke-WebRequest "$Base/api/session/check" -UseBasicParsing -TimeoutSec 2) | Out-Null; $srvOk = $true } catch { if ($_.Exception.Response) { $srvOk = $true } }
    try { (Invoke-WebRequest "http://127.0.0.1:$fakePort/__health" -UseBasicParsing -TimeoutSec 2) | Out-Null; $fakeOk = $true } catch { }
  } while ((Get-Date) -lt $deadline -and (-not $srvOk -or -not $fakeOk))

  if (-not $srvOk) { throw "isolated server did not start on $Base (see $srvLog)" }
  if (-not $fakeOk) { throw "fake model server did not start on 127.0.0.1:$fakePort (see $fakeLog)" }
  Write-Output "isolated server and fake model ready ($Base / 127.0.0.1:$fakePort)"

  $env:SHINIAN_BASE = $Base
  $env:SHINIAN_FAKE_BASE = "http://127.0.0.1:$fakePort"
  $env:SHINIAN_FAKE_KEY = "test-secret-key"
  & node (Join-Path $root "scripts\e2e_ask.mjs")
  $code = $LASTEXITCODE
} finally {
  Stop-Tree $srv
  Stop-Tree $fake
  Start-Sleep -Milliseconds 300
}
exit $code
