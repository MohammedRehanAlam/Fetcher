@echo off
echo ============================================
echo  Fetcher — Manifest Generator
echo  Scans ALL supported document types
echo ============================================
echo.
echo Scanning database folder...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = (Get-Location).Path;" ^
  "$dbPath = Join-Path $root 'database';" ^
  "if (-not (Test-Path $dbPath)) { Write-Host 'ERROR: database folder not found!' -ForegroundColor Red; Read-Host; exit 1; }" ^
  "$exts = @('*.pdf','*.docx','*.pptx','*.xlsx','*.xls','*.txt','*.csv','*.rtf','*.odt','*.odp','*.ods');" ^
  "$files = ($exts | ForEach-Object { Get-ChildItem -Path $dbPath -Recurse -Filter $_ } | Sort-Object FullName |" ^
  "  ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') }) | Select-Object -Unique;" ^
  "$json = if (@($files).Count -eq 0) { '[]' } else { $files | ConvertTo-Json };" ^
  "Set-Content -Path (Join-Path $dbPath 'manifest.json') -Value $json -Encoding UTF8;" ^
  "Write-Host ('Found ' + @($files).Count + ' document(s).') -ForegroundColor Green;" ^
  "Write-Host 'manifest.json created!' -ForegroundColor Green"

echo.
echo Done! Open index.html and click "Use Database Folder".
echo.
pause
