$ErrorActionPreference = "Stop"

npm run build

$builderOutput = & npx electron-builder --win dir --publish never 2>&1
$builderExit = $LASTEXITCODE
$releaseDir = Join-Path $PSScriptRoot "..\release\win-unpacked"
$exePath = Join-Path $releaseDir "AI API load balancer.exe"
$zipPath = Join-Path $PSScriptRoot "..\release\AI-API-load-balancer-portable-folder.zip"

if (!(Test-Path $exePath)) {
  $builderOutput | Write-Output
  if ($builderExit -ne 0) {
    exit $builderExit
  }
  throw "Electron builder did not create $exePath"
}

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $releaseDir "*") -DestinationPath $zipPath -Force

if ($builderExit -ne 0) {
  Write-Warning "electron-builder returned exit code $builderExit after creating the unpacked app. The portable folder zip was still created."
}

Write-Output "Portable folder created: $zipPath"