# View backend logs
$logFile = Join-Path (Split-Path $MyInvocation.MyCommand.Path) "logs\backend.log"

if (-not (Test-Path $logFile)) {
    Write-Host "❌ Log file not found: $logFile" -ForegroundColor Red
    exit 1
}

Write-Host "📋 Backend Logs: $logFile" -ForegroundColor Cyan
Write-Host ("=" * 80)
Write-Host ""

# Display last 50 lines with colors
$lines = Get-Content $logFile | Select-Object -Last 50

foreach ($line in $lines) {
    # Color based on content
    if ($line -match "✅") {
        Write-Host $line -ForegroundColor Green
    } elseif ($line -match "❌") {
        Write-Host $line -ForegroundColor Red
    } elseif ($line -match "⚠️") {
        Write-Host $line -ForegroundColor Yellow
    } elseif ($line -match "ERROR") {
        Write-Host $line -ForegroundColor Red
    } elseif ($line -match "INFO") {
        Write-Host $line -ForegroundColor Cyan
    } else {
        Write-Host $line
    }
}

Write-Host ""
Write-Host ("=" * 80)
Write-Host "💡 To follow logs in real-time, use: Get-Content -Path '$logFile' -Wait"
