# Builds release\ : WorkanaAssistant.exe (hub + dashboard) and both Chrome extensions.
# Usage (from the project root):  powershell -ExecutionPolicy Bypass -File tools\build-release.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$rel = Join-Path $root "release"
$build = Join-Path $root "build"
# Keep the user's settings (.env with the shared secret) and database across rebuilds.
$keep = Join-Path $build "keep"
if (Test-Path $keep) { Remove-Item $keep -Recurse -Force }
New-Item -ItemType Directory -Force $keep | Out-Null
foreach ($k in ".env", "data") {
  if (Test-Path "$rel\WorkanaAssistant\$k") { Copy-Item "$rel\WorkanaAssistant\$k" $keep -Recurse }
}
if (Test-Path $rel) { Remove-Item $rel -Recurse -Force }
New-Item -ItemType Directory -Force "$rel\WorkanaAssistant", "$rel\extensions" | Out-Null

Write-Host "== building dashboard + extensions"
npm run build:ext
if ($LASTEXITCODE -ne 0) { throw "extension build failed" }
npm --prefix dashboard run build
if ($LASTEXITCODE -ne 0) { throw "dashboard build failed" }

Write-Host "== building WorkanaAssistant.exe"
& .venv\Scripts\python -m PyInstaller --noconfirm --clean --onefile --console `
  --name WorkanaAssistant `
  --distpath "$rel\WorkanaAssistant" --workpath "$build" --specpath "$build" `
  --paths "$root" `
  --add-data "$root\dashboard\dist;dashboard\dist" `
  --add-data "$root\.env.example;." `
  --collect-submodules hub `
  --collect-submodules uvicorn `
  --collect-submodules websockets `
  --hidden-import requests --hidden-import bs4 `
  --collect-all curl_cffi `
  tools\exe_entry.py
if ($LASTEXITCODE -ne 0) { throw "pyinstaller failed" }

# Editable fetcher next to the exe + settings template
Copy-Item hub\fetcher\my_fetcher.py "$rel\WorkanaAssistant\my_fetcher.py"
Copy-Item .env.example "$rel\WorkanaAssistant\.env.example"
Get-ChildItem $keep -Force | ForEach-Object { Copy-Item $_.FullName "$rel\WorkanaAssistant" -Recurse }

Write-Host "== packaging extensions"
foreach ($e in "ext-chatgpt", "ext-workana") {
  Copy-Item "$e\dist" "$rel\extensions\$e" -Recurse
  Compress-Archive -Path "$e\dist\*" -DestinationPath "$rel\extensions\$e.zip" -Force
}
Copy-Item README.md "$rel\README.md"
Copy-Item tools\RELEASE-QUICKSTART.txt "$rel\QUICKSTART.txt"
Write-Host "== done: $rel"
