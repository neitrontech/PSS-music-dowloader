# Подпись расширения в AMO (unlisted / self-distribution) и подготовка .xpi к установке.
#
# Ключи берутся из build\amo-keys.json  {"key": "user:12345678:90", "secret": "..."}
# либо из переменных окружения WEB_EXT_API_KEY / WEB_EXT_API_SECRET.

param(
  [string]$KeyFile = "build\amo-keys.json",
  [string]$Channel = "unlisted",
  [string]$SourceDir = "vk-music-downloader",
  [string]$ArtifactsDir = "build\artifacts"
)

$ErrorActionPreference = 'Stop'

$key = $env:WEB_EXT_API_KEY
$secret = $env:WEB_EXT_API_SECRET

if (Test-Path $KeyFile) {
  $cfg = Get-Content $KeyFile -Raw | ConvertFrom-Json
  if ($cfg.key) { $key = $cfg.key }
  if ($cfg.secret) { $secret = $cfg.secret }
}

if (-not $key -or -not $secret) {
  throw "Ключи AMO не найдены: положите их в $KeyFile или задайте WEB_EXT_API_KEY / WEB_EXT_API_SECRET"
}

New-Item -ItemType Directory -Force $ArtifactsDir | Out-Null
Get-ChildItem $ArtifactsDir -Filter *.xpi -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "Подписываю $SourceDir в канале $Channel ..." -ForegroundColor Cyan

npx --yes web-ext@latest sign `
  --source-dir $SourceDir `
  --channel $Channel `
  --api-key $key `
  --api-secret $secret `
  --artifacts-dir $ArtifactsDir `
  --approval-timeout 600000

if ($LASTEXITCODE -ne 0) { throw "web-ext sign завершился с кодом $LASTEXITCODE" }

$xpi = Get-ChildItem $ArtifactsDir -Filter *.xpi | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $xpi) { throw "Подписанный .xpi не найден в $ArtifactsDir" }

$xpi.FullName
"размер: {0:N0} КБ" -f ($xpi.Length / 1KB)
