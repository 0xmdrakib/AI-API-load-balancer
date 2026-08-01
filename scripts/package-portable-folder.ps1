$ErrorActionPreference = "Stop"

npm run desktop:pack:single
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exePath = Join-Path $PSScriptRoot "..\release\AI Load Balancer.exe"
$zipPath = Join-Path $PSScriptRoot "..\release\AI Load Balancer.zip"

if (!(Test-Path -LiteralPath $exePath)) {
  throw "Electron builder did not create $exePath"
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -LiteralPath $exePath -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output "EXE-only archive created: $zipPath"
