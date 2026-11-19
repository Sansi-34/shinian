# 拾念 SHINIAN · 「主题页」QA 一键隔离验收
# 启动独立服务（默认 3230 / db/topics-e2e.sqlite / db/topics-e2e-master.key）与假模型（默认 3501），
# 运行 scripts/e2e_topics.mjs 与 scripts/test_topics_export.py，结束后只清理本脚本启动的进程。
# 绝不触碰 3000 端口的主服务。
#
# 用法：
#   powershell -NoProfile -File scripts\run_e2e_topics.ps1
#   powershell -NoProfile -File scripts\run_e2e_topics.ps1 -Port 3231 -FakePort 3501
#   powershell -NoProfile -File scripts\run_e2e_topics.ps1 -KeepDb          # 保留隔离库排查
#   powershell -NoProfile -File scripts\run_e2e_topics.ps1 -SkipExport      # 只跑浏览器验收
#   powershell -NoProfile -File scripts\run_e2e_topics.ps1 -Regression      # 追加受影响回归
#
# 默认端口 3230 被占用时自动切换到 3231 并提示；3231 也被占用则停止，避免误杀其他进程。
# 前置：npm install 且已执行 npm run build（脚本只检查 dist/client/index.html，不自动构建）。
param(
  [int]$Port = 3230,
  [int]$FakePort = 3501,
  [switch]$KeepDb,
  [switch]$SkipExport,
  [switch]$SkipRestart,
  [switch]$Regression
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $root "output"
if (-not (Test-Path -LiteralPath $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
$logPath = Join-Path $outputDir "topics-e2e-last.log"
$failurePath = Join-Path $outputDir "topics-e2e-failures.txt"

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

# ---- 默认端口被占用时切到 3231（只提示，不杀占用者） ----
$requestedPort = $Port
if (Test-TcpPort $Port) {
  $fallback = 3231
  if ($Port -eq $fallback) {
    throw "端口 $Port 已被占用；为避免误杀其他进程，请用 -Port 指定其他端口。"
  }
  if (Test-TcpPort $fallback) {
    throw "默认端口 $Port 与备用端口 $fallback 均被占用；为避免误杀其他进程，请用 -Port 指定其他端口。"
  }
  $Port = $fallback
  Write-Warning "默认端口 $requestedPort 已被占用，自动切换到 $Port（未触碰占用进程；可用 -Port 指定其他端口）。"
}

$Base = "http://127.0.0.1:$Port"
$FakeBase = "http://127.0.0.1:$FakePort"
$nextPort = $Port + 1

# ---- 固定路径并先做安全校验，避免误删 ----
$dbDir = Join-Path $root "db"
$dbPath = Join-Path $dbDir "topics-e2e.sqlite"
$keyPath = Join-Path $dbDir "topics-e2e-master.key"
$srvLog = Join-Path $dbDir "topics-e2e-server.log"
$srvErrLog = Join-Path $dbDir "topics-e2e-server.log.err"
$fakeLog = Join-Path $dbDir "fake-topics-e2e.log"
$fakeErrLog = Join-Path $dbDir "fake-topics-e2e.log.err"

$dbDirFull = [System.IO.Path]::GetFullPath($dbDir)
$allowedNames = @(
  "topics-e2e.sqlite",
  "topics-e2e.sqlite-wal",
  "topics-e2e.sqlite-shm",
  "topics-e2e-master.key"
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
  $parent = [System.IO.Path]::GetDirectoryName($full)
  if ($parent -ne $dbDirFull -or $allowedNames -notcontains $leaf) {
    throw "拒绝清理未经验证的路径：$full"
  }
}

# ---- 构建产物检查（不自动 build）----
if (-not (Test-Path (Join-Path $root "dist\client\index.html"))) {
  Write-Error "缺少 dist\client\index.html。请先在 $root 执行：npm run build"
  exit 2
}
$chrome = $env:SHINIAN_CHROME
if (-not $chrome) { $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path -LiteralPath $chrome)) {
  Write-Error "未找到 Chrome：$chrome。请设置 SHINIAN_CHROME 指向 chrome.exe。"
  exit 2
}

Write-Output "BASE  = $Base"
Write-Output "DB    = $dbPath"
Write-Output "FAKE  = $FakeBase"
Write-Output "LOG   = $logPath"
Write-Output "SHOTS = $(Join-Path $root 'shots')"

$fake = $null
$srv = $null
$fakeStarted = $false
$e2eCode = 1
$exportCode = 0
$regressionCode = 0
$runStarted = Get-Date

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

  # ---- 浏览器端到端验收 ----
  $env:SHINIAN_BASE = $Base
  $env:SHINIAN_FAKE_BASE = $FakeBase
  $env:SHINIAN_DB = $dbPath
  $env:SHINIAN_CHROME = $chrome
  $env:SHINIAN_TOPIC_LOG = $logPath
  $env:SHINIAN_TOPIC_FAILURES = $failurePath
  Write-Output "`n===== e2e_topics.mjs（main） ====="
  $e2eOutput = & node (Join-Path $root "scripts\e2e_topics.mjs") --phase main 2>&1
  $e2eCode = $LASTEXITCODE
  $e2eOutput | ForEach-Object { Write-Output $_ }

  # ---- 重启隔离服务，复查固定下一步/成员持久性（同一 DB，不清理）----
  if (-not $SkipRestart) {
    Write-Output "`n===== 重启隔离服务（同一 DB，端口 $Port） ====="
    Stop-Tree $srv
    Start-Sleep -Milliseconds 800
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
        throw "隔离服务重启后提前退出（exit=$($srv.ExitCode)），见 $srvLog / $srvErrLog"
      }
    } while (-not $srvReady -and (Get-Date) -lt $deadline)
    if (-not $srvReady) { throw "隔离服务重启后未能在 $Base 就绪（见 $srvLog / $srvErrLog）" }
    Write-Output "隔离服务已重启：$Base"
    Write-Output "`n===== e2e_topics.mjs（restart） ====="
    $restartOutput = & node (Join-Path $root "scripts\e2e_topics.mjs") --phase restart 2>&1
    $restartCode = $LASTEXITCODE
    $restartOutput | ForEach-Object { Write-Output $_ }
    if ($restartCode -ne 0) { $e2eCode = $restartCode }
  }

  # ---- 导出 / 备份恢复断言（schemaVersion 7 + topics/topicMembers）----
  if (-not $SkipExport) {
    Write-Output "`n===== test_topics_export.py ====="
    $env:SHINIAN_BASE = $Base
    $env:SHINIAN_TOPICS_TEST_DB = $dbPath
    $exportOutput = & python (Join-Path $root "scripts\test_topics_export.py") 2>&1
    $exportCode = $LASTEXITCODE
    $exportOutput | ForEach-Object { Write-Output $_ }
    $exportOutput | Tee-Object -FilePath $logPath -Append | Out-Null
  }

  # ---- 受影响回归（可选；各自使用独立库/端口）----
  if ($Regression) {
    Write-Output "`n===== regression ====="
    $regressionSuites = @(
      "scripts/test_search.py",
      "scripts/test_consistency.py",
      "scripts/test_ask.py",
      "scripts/test_export.py",
      "scripts/test_backup_restore.py"
    )
    foreach ($suite in $regressionSuites) {
      Write-Output "`n--- $suite ---"
      $suiteOutput = & python (Join-Path $root $suite) 2>&1
      $suiteCode = $LASTEXITCODE
      $suiteOutput | Tee-Object -FilePath $logPath -Append
      if ($suiteCode -ne 0) { $regressionCode = $suiteCode }
    }
  }
} catch {
  Write-Error $_
  $e2eCode = 1
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

  if (-not $KeepDb) {
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
  } else {
    Write-Output "已保留隔离库：$dbPath（-KeepDb）。"
  }
}

# ---- 汇总两个套件的 RESULT，给出唯一最终 RESULT ----
$allText = ""
if (Test-Path -LiteralPath $logPath) { $allText = Get-Content -LiteralPath $logPath -Raw -Encoding UTF8 }
$passedTotal = 0
$failedTotal = 0
foreach ($m in [regex]::Matches($allText, 'RESULT\s+(\d+)\s+passed,\s+(\d+)\s+failed')) {
  $passedTotal += [int]$m.Groups[1].Value
  $failedTotal += [int]$m.Groups[2].Value
}
if ($SkipExport -and $passedTotal -eq 0) {
  # 日志写入失败等极端情况：至少让退出码反映失败
  $failedTotal = 1
}
$elapsed = [int]((Get-Date) - $runStarted).TotalSeconds
Write-Output "`nTOTAL elapsed ${elapsed}s"
Write-Output "RESULT $passedTotal passed, $failedTotal failed"
if ($e2eCode -ne 0 -or $exportCode -ne 0 -or $regressionCode -ne 0 -or $failedTotal -gt 0) { exit 1 }
exit 0
