@set "SCRIPT_DIR=%~dp0"
@powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content '%~f0') | Where-Object { $_ -notmatch '^@' } | Out-String | Invoke-Expression"
@pause
@exit /b

# Fetcher - Manifest Generator (Natural Sort)
# Highly Optimized Schwartzian-Transform & .NET implementation
# Running inside a single-file hybrid CMD / PowerShell script.

$sw = [System.Diagnostics.Stopwatch]::StartNew()

$root = $env:SCRIPT_DIR
if (-not $root) { $root = $PSScriptRoot }
if (-not $root) { $root = (Get-Location).Path }
$root = $root.TrimEnd('\').TrimEnd('/')

$appJsPath = Join-Path $root "app.js"
if (Test-Path $appJsPath) {
    $appJs = Get-Content $appJsPath -Raw
    $dbDir = if ($appJs -match 'const\s+DATABASE_DIR_NAME\s*=\s*''([^'']+)''') { $Matches[1] } else { 'database' }
} else {
    $dbDir = 'database'
}

$dbPath = Join-Path $root $dbDir
if (-not (Test-Path $dbPath)) {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Red
    Write-Host "  ERROR: '$dbDir' database folder not found!" -ForegroundColor Red
    Write-Host "  Please ensure this script is in the Fetcher root." -ForegroundColor Red
    Write-Host "==================================================" -ForegroundColor Red
    Write-Host ""
    exit 1
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  FETCHER - Intelligent Document Search Engine" -ForegroundColor Cyan
Write-Host "  Manifest Generator (Natural Numerical Sort)" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "   Database Directory : $dbDir" -ForegroundColor White
Write-Host "   Supported Formats  : pdf, docx, pptx, xlsx, xls, txt, csv, rtf, odt, odp, ods, srt, vtt" -ForegroundColor Gray
Write-Host ""
Write-Host "--------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "   Scanning all folders recursively..." -ForegroundColor Yellow

$allowedExts = @('.pdf','.docx','.pptx','.xlsx','.xls','.txt','.csv','.rtf','.odt','.odp','.ods','.srt','.vtt')
$allowedExtsHash = [System.Collections.Generic.HashSet[string]]::new([string[]]$allowedExts, [System.StringComparer]::OrdinalIgnoreCase)
$list = [System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[string, string]]]::new()

$evaluator = [System.Text.RegularExpressions.MatchEvaluator] {
    param($match)
    $match.Value.PadLeft(10, '0')
}
$regex = [System.Text.RegularExpressions.Regex]::new('\d+')

# Fast .NET File Enumeration
foreach ($file in [System.IO.Directory]::EnumerateFiles($dbPath, "*", [System.IO.SearchOption]::AllDirectories)) {
    $ext = [System.IO.Path]::GetExtension($file)
    if ($allowedExtsHash.Contains($ext)) {
        $filename = [System.IO.Path]::GetFileName($file)
        if ($filename -ne 'manifest.json' -and -not $filename.StartsWith('search-index') -and $filename -ne 'search-index-report.json' -and $filename -ne 'README.txt') {
            # Convert to relative path with forward slashes
            $relPath = $file.Substring($root.Length + 1).Replace('\', '/')
            
            # Pre-compute natural sort key (Schwartzian Transform)
            $sortKey = $regex.Replace($relPath, $evaluator)
            
            $kvp = [System.Collections.Generic.KeyValuePair[string, string]]::new($sortKey, $relPath)
            $list.Add($kvp)
        }
    }
}

Write-Host "   [OK] Folder scanning completed." -ForegroundColor Green
Write-Host ""
Write-Host "   Processing and Sorting:" -ForegroundColor Yellow
Write-Host "   - Found $($list.Count) files." -ForegroundColor Gray

# Sort natural keys using .NET comparisons
$list.Sort([System.Comparison[System.Collections.Generic.KeyValuePair[string, string]]] {
    param($a, $b)
    [System.String]::Compare($a.Key, $b.Key, [System.StringComparison]::OrdinalIgnoreCase)
})
Write-Host "   - Natural numerical sorting completed using .NET Schwartzian Transform." -ForegroundColor Gray
Write-Host ""

Write-Host "   Writing output:" -ForegroundColor Yellow

# Custom JSON construction (Grouping directories with visual spaces)
$jsonLines = [System.Collections.Generic.List[string]]::new()
$jsonLines.Add("[")
$lastDir = $null
for ($i = 0; $i -lt $list.Count; $i++) {
    $file = $list[$i].Value
    
    # Fast directory extraction
    $lastSlash = $file.LastIndexOf('/')
    $currentDir = if ($lastSlash -gt -1) { $file.Substring(0, $lastSlash) } else { "" }
    
    if ($null -ne $lastDir -and $currentDir -ne $lastDir) {
        $jsonLines.Add("")
    }
    $lastDir = $currentDir
    
    $comma = if ($i -eq $list.Count - 1) { "" } else { "," }
    $jsonLines.Add("    `"" + $file + "`"" + $comma)
}
$jsonLines.Add("]")
$json = $jsonLines -join [Environment]::NewLine

# Save manifest.json
$manifestPath = Join-Path $dbPath 'manifest.json'
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "   [OK] manifest.json generated successfully." -ForegroundColor Green
Write-Host ""

$sw.Stop()
$elapsed = [Math]::Round($sw.Elapsed.TotalSeconds, 2)

Write-Host "   SUCCESS - Finished in $elapsed seconds!" -ForegroundColor Green
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
