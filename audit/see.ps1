# audit/see.ps1 - zero-plugin "look at this screenshot" helper (ASCII-only source).
# Sends one local image (optionally cropped) to the vision model behind the ds provider
# and returns the model's text answer.
# Usage:
#   & .\audit\see.ps1 -Path audit/shots/x.png -Prompt "what do you see" [-Crop "0,600,1280,760"] [-Model cn:glm-5.3]
param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$Prompt,
  [string]$Model = 'cn:glm-5.3',
  [string]$Crop = '',
  [int]$MaxWidth = 1280,
  [int]$MaxTokens = 900,
  [int]$TimeoutSec = 180
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

# --- resolve base URL and key (reuse the harness ds provider, never print the key) ---
$patch = Get-Content "$env:DSH_PROFILE_DIR\cordis.patch.yml"
$base = $null; $keyEnv = $null
foreach ($l in $patch) {
  if (-not $base -and $l -match 'baseURL:\s*["'']?([^"''\s]+)') { $base = $Matches[1] }
  if (-not $keyEnv -and $l -match 'apiKeyEnv:\s*(\S+)') { $keyEnv = $Matches[1] }
  if ($base -and $keyEnv) { break }
}
$key = [Environment]::GetEnvironmentVariable($keyEnv)
if (-not $key) {
  $cred = Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml" -Raw -ErrorAction SilentlyContinue
  $m = [regex]::Match($cred, [regex]::Escape($keyEnv) + "\s*:\s*['`"]?([A-Za-z0-9_\-\.]+)")
  if ($m.Success) { $key = $m.Groups[1].Value }
}
if (-not $key) { throw "no credential for $keyEnv" }

# --- load, crop, downscale ---
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Path))
try {
  if ($Crop) {
    $p = $Crop.Split(',') | ForEach-Object { [int]$_.Trim() }
    $cw = [Math]::Min($p[2], $src.Width - $p[0])
    $ch = [Math]::Min($p[3], $src.Height - $p[1])
    $rect = New-Object System.Drawing.Rectangle($p[0], $p[1], $cw, $ch)
    $bmp = New-Object System.Drawing.Bitmap($cw, $ch)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
  } else {
    $bmp = New-Object System.Drawing.Bitmap($src)
  }
  if ($bmp.Width -gt $MaxWidth) {
    $nh = [int]($bmp.Height * $MaxWidth / $bmp.Width)
    $small = New-Object System.Drawing.Bitmap($MaxWidth, $nh)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $MaxWidth, $nh)
    $g2.Dispose(); $bmp.Dispose(); $bmp = $small
  }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $W = $bmp.Width; $H = $bmp.Height
  $ms.Dispose(); $bmp.Dispose()
} finally { $src.Dispose() }

$b64 = [Convert]::ToBase64String($bytes)
Write-Output ("[see] model={0} size={1}x{2} bytes={3}KB crop={4}" -f $Model, $W, $H, [math]::Round($bytes.Length/1KB), $Crop)

$payload = @{
  model      = $Model
  max_tokens = $MaxTokens
  messages   = @(@{
      role    = 'user'
      content = @(
        @{ type = 'text'; text = $Prompt },
        @{ type = 'image_url'; image_url = @{ url = ('data:image/png;base64,' + $b64) } }
      )
    })
}
$json = $payload | ConvertTo-Json -Depth 8 -Compress
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $uri = $base.TrimEnd('/') + '/chat/completions'
  # WebClient + 显式 UTF-8 解码：Invoke-RestMethod 在 PS 5.1 会把无 charset 的 JSON 按 ISO-8859-1 解，中文变乱码
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('Authorization', 'Bearer ' + $key)
  $wc.Headers.Add('Content-Type', 'application/json; charset=utf-8')
  $raw = $wc.UploadData($uri, 'POST', [Text.Encoding]::UTF8.GetBytes($json))
  $sw.Stop()
  $jsonText = [Text.Encoding]::UTF8.GetString($raw)
  $resp = $jsonText | ConvertFrom-Json
  $text = $resp.choices[0].message.content
  Write-Output ("[see] ok in {0:N1}s" -f $sw.Elapsed.TotalSeconds)
  Write-Output '----- answer -----'
  Write-Output $text
  $outFile = Join-Path $PSScriptRoot 'see-last.txt'
  ($Prompt + "`n----`n" + $text) | Set-Content -Path $outFile -Encoding UTF8
} catch {
  $code = 0
  try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
  $detail = ''
  try { $detail = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch { $detail = $_.Exception.Message }
  Write-Output ("[see] failed HTTP {0}: {1}" -f $code, $detail)
  exit 1
}
