# 拾念 SHINIAN · 「问我的记录」QA 一键隔离验收
# 启动独立服务（默认 3212 / db/ask-e2e.sqlite / db/ask-e2e-master.key）与假模型（默认 3501），
# 运行 scripts/e2e_ask_acceptance.mjs，结束后只清理本脚本启动的进程；绝不触碰 3000 端口的主服务。
#
# 用法：
#   powershell -NoProfile -File scripts\run_ask_e2e_acceptance.ps1
#   powershell -NoProfile -File scripts\run_ask_e2e_acceptance.ps1 -Port 3214
#   powershell -NoProfile -File scripts\run_ask_e2e_acceptance.ps1 -FakePort 3502
#
# 前置：npm install 且已执行 npm run build（脚本只检查 dist/client/index.html，不自动构建）。
param(
  [int]$Port = 3212,
  [int]$FakePort = 3501
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$Base = "http://127.0.0.1:$Port"
$FakeBase = "http://127.0.0.1:$FakePort"
$nextPort = $Port + 1

if ($Port -eq 3000 -or $FakePort -eq 3000) {
  throw "隔离验收禁止使用 3000 端口（主服务）。"
}
if ($Port -eq $FakePort) {
  throw "应用端口与假模型端口不能相同。"
}

function Test-Endpoint([string]$Url) {
  try {
    Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    if ($_.Exception.Response) { return $true }
    return $false
  }
}

function Test-TcpPort([int]$TargetPort) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $client.Connect('127.0.0.1', $TargetPort)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Stop-Tree($Process) {
  if (-not $Process) { return }
  $running = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
  if (-not $running) { return }
  & taskkill /PID $Process.Id /T /F 2>$null | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue)) { return }
  }
}

# ---- 固定路径并先做安全校验，避免误删 ----
$dbDir = Join-Path $root "db"
$dbPath = Join-Path $dbDir "ask-e2e.sqlite"
$keyPath = Join-Path $dbDir "ask-e2e-master.key"
$srvLog = Join-Path $dbDir "ask-e2e-acceptance-server.log"
$srvErrLog = Join-Path $dbDir "ask-e2e-acceptance-server.log.err"
$fakeLog = Join-Path $dbDir "fake-ask-acceptance.log"
$fakeErrLog = Join-Path $dbDir "fake-ask-acceptance.log.err"

$dbDirFull = [System.IO.Path]::GetFullPath($dbDir)
$allowedNames = @(
  "ask-e2e.sqlite",
  "ask-e2e.sqlite-wal",
  "ask-e2e.sqlite-shm",
  "ask-e2e-master.key"
)
$cleanupTargets = @(
  $dbPath,
  "$dbPath-wal",
  "$dbPath-shm",
  $keyPath
)
foreach ($target in $cleanupTargets) {
  $full = [System.IO.Path]::GetFullPath($target)
  $leaf = [System.IO.Path]::GetFileName($full)
  $inside = $full.StartsWith($dbDirFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $inside -or $allowedNames -notcontains $leaf) {
    throw "拒绝清理未经验证的路径：$full"
  }
}

# ---- 构建产物检查（不自动 build）----
if (-not (Test-Path (Join-Path $root "dist\client\index.html"))) {
  Write-Error "缺少 dist\client\index.html。请先在 $root 执行：npm run build"
  exit 2
}

Write-Output "BASE = $Base"
Write-Output "DB   = $dbPath"
Write-Output "FAKE = $FakeBase"

if (Test-TcpPort $Port) {
  Write-Error "端口 $Port 已被占用；为避免误杀其他进程，本脚本不会继续。请换端口：-Port $nextPort"
  exit 3
}

$fake = $null
$srv = $null
$fakeStarted = $false
$code = 1

try {
  # ---- 假模型：已在运行则复用且不杀；未运行才启动并标记为“自己启动” ----
  $fakeReady = $false
  try {
    $health = (Invoke-WebRequest "http://127.0.0.1:$FakePort/__health" -UseBasicParsing -TimeoutSec 2).Content | ConvertFrom-Json
    if ($health.service -eq "shinian-fake-model") { $fakeReady = $true }
  } catch { }
  if (-not $fakeReady) {
    if (Test-TcpPort $FakePort) {
      throw "端口 $FakePort 已被非假模型服务占用，无法启动 fake_model_server.py。"
    }
    $python = (Get-Command python -ErrorAction SilentlyContinue)
    if (-not $python) { throw "未找到 python，无法启动 scripts/fake_model_server.py。" }
    $env:PYTHONIOENCODING = "utf-8"
    $env:SHINIAN_FAKE_PORT = "$FakePort"
    $fake = Start-Process -FilePath $python.Source -ArgumentList "scripts/fake_model_server.py" `
      -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput $fakeLog -RedirectStandardError $fakeErrLog -PassThru
    $fakeStarted = $true
    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 400
      $fakeReady = Test-Endpoint "http://127.0.0.1:$FakePort/__health"
    } while (-not $fakeReady -and (Get-Date) -lt $deadline)
    if (-not $fakeReady) { throw "假模型未能在 $FakePort 启动（见 $fakeLog / $fakeErrLog）" }
  } else {
    Write-Output "复用已在运行的 fake_model_server（$FakeBase），退出时不会结束它。"
  }

  # ---- 清理旧隔离库（路径已在上方校验）----
  foreach ($target in $cleanupTargets) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force -ErrorAction Stop
    }
  }

  # ---- 启动隔离服务 ----
  $env:PORT = "$Port"
  $env:DATABASE_URL = $dbPath
  $env:SHINIAN_MASTER_KEY_FILE = $keyPath
  $env:NODE_ENV = "production"
  $srv = Start-Process -FilePath "node" `
    -ArgumentList "node_modules/tsx/dist/cli.mjs", "src/server/index.ts" `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $srvLog -RedirectStandardError $srvErrLog -PassThru

  $deadline = (Get-Date).AddSeconds(45)
  $srvReady = $false
  do {
    Start-Sleep -Milliseconds 500
    $srvReady = Test-Endpoint "$Base/api/session/check"
    if (-not $srvReady -and $srv.HasExited) {
      throw "隔离服务提前退出（exit=$($srv.ExitCode)），见 $srvLog / $srvErrLog"
    }
  } while (-not $srvReady -and (Get-Date) -lt $deadline)
  if (-not $srvReady) { throw "隔离服务未能在 $Base 启动（见 $srvLog / $srvErrLog）" }
  Write-Output "隔离服务已就绪：$Base"

  # ---- 运行浏览器端到端 ----
  $env:SHINIAN_BASE = $Base
  $env:SHINIAN_FAKE_BASE = $FakeBase
  $env:SHINIAN_DB = $dbPath
  & node (Join-Path $root "scripts\e2e_ask_acceptance.mjs")
  $code = $LASTEXITCODE
} finally {
  Stop-Tree $srv
  if ($fakeStarted) {
    Stop-Tree $fake
  } else {
    Write-Output "保留复用的 fake_model_server（非本脚本启动）。"
  }
  Start-Sleep -Milliseconds 800

  # 3000 主服务只做观测，绝不做任何结束操作
  $mainAlive = Test-Endpoint "http://127.0.0.1:3000/api/session/check"
  Write-Output ("主服务 3000 状态（未触碰）：" + $(if ($mainAlive) { "运行中" } else { "未运行/不可达" }))

  foreach ($target in $cleanupTargets) {
    if (-not (Test-Path -LiteralPath $target)) { continue }
    for ($i = 0; $i -lt 10; $i++) {
      try {
        Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        break
      } catch {
        Start-Sleep -Milliseconds 300
      }
    }
  }
  Write-Output "已清理隔离库（$dbPath）及其 WAL/SHM、master key。"
}

exit $code
