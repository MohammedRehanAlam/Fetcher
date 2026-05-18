@echo off
echo ============================================
echo  Fetcher - Manifest Generator (Natural Sort)
echo  Scans ALL supported document types
echo ============================================
echo.
echo Scanning database folder...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = (Get-Location).Path;" ^
  "$dbPath = Join-Path $root 'database';" ^
  "if (-not (Test-Path $dbPath)) { Write-Host 'ERROR: database folder not found!' -ForegroundColor Red; Read-Host; exit 1; }" ^
  "$exts = @('*.pdf','*.docx','*.pptx','*.xlsx','*.xls','*.txt','*.csv','*.rtf','*.odt','*.odp','*.ods','*.srt','*.vtt');" ^
  "$files = ($exts | ForEach-Object { Get-ChildItem -Path $dbPath -Recurse -Filter $_ } | " ^
  "  ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') }) | " ^
  "  Where-Object { $filename = [System.IO.Path]::GetFileName($_); $filename -ne 'manifest.json' -and -not $filename.StartsWith('search-index') -and $filename -ne 'indexing-report.json' -and $filename -ne 'README.txt' } | " ^
  "  Select-Object -Unique;" ^
  "$sortedFiles = $files | Sort-Object { [regex]::Replace($_, '\d+', { $args[0].Value.PadLeft(10, '0') }) };" ^
  "$json = if (@($sortedFiles).Count -eq 0) { '[]' } else { ConvertTo-Json @($sortedFiles) -Depth 10 };" ^
  "if (@($sortedFiles).Count -gt 0) {" ^
  "  $lines = $json -split '\r?\n';" ^
  "  $formattedLines = [System.Collections.Generic.List[string]]::new();" ^
  "  $lastDir = $null;" ^
  "  foreach ($line in $lines) {" ^
  "      $cleanPath = $line -replace '[^a-zA-Z0-9_/.-]', '';" ^
  "      if ($cleanPath.StartsWith('database/')) {" ^
  "          $currentDir = $cleanPath -replace '/[^/]+$', '';" ^
  "          if ($null -ne $lastDir -and $currentDir -ne $lastDir) {" ^
  "              $formattedLines.Add('');" ^
  "          }" ^
  "          $lastDir = $currentDir;" ^
  "      }" ^
  "      $formattedLines.Add($line);" ^
  "  }" ^
  "  $json = $formattedLines -join [Environment]::NewLine;" ^
  "}" ^
  "$manifestPath = Join-Path $dbPath 'manifest.json';" ^
  "[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)));" ^
  "Write-Host ('Found ' + @($sortedFiles).Count + ' document(s).') -ForegroundColor Green;" ^
  "Write-Host 'manifest.json created successfully in natural numerical order!' -ForegroundColor Green"

echo.
pause
