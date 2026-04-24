$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "================================" -ForegroundColor Cyan
Write-Host "TFS Agent Backend Startup" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check virtual environment
Write-Host "[1/3] Checking virtual environment..." -ForegroundColor Yellow
$venvPython = Join-Path $scriptDir ".venv\Scripts\python.exe"
$backendReqFile = Join-Path $scriptDir "requirements.txt"

if (-not (Test-Path $venvPython)) {
    Write-Host "Setting up virtual environment (first time only)..." -ForegroundColor Yellow
    # Try 'py' first (Python Launcher), then fall back to 'python'
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -m venv .venv 2>&1 | Out-Null
    } else {
        & python -m venv .venv 2>&1 | Out-Null
    }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to create virtual environment. Ensure Python is installed." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[OK] Python environment ready" -ForegroundColor Green

# Step 2: Install dependencies (only if .venv is new or requirements changed)
$pipCachePath = Join-Path $scriptDir ".venv\.pip-installed"
$reqHash = (Get-FileHash $backendReqFile -Algorithm MD5).Hash

if (-not (Test-Path $pipCachePath)) {
    Write-Host "[2/3] Installing dependencies (first time only)..." -ForegroundColor Yellow
    
    & $venvPython -m pip install --upgrade pip setuptools wheel
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: Failed to upgrade pip" -ForegroundColor Red; exit 1 }
    
    & $venvPython -m pip install -r $backendReqFile
    if ($LASTEXITCODE -ne 0) { 
        Write-Host "ERROR: Failed to install dependencies. Check if you have enough disk space." -ForegroundColor Red
        exit 1 
    }
    
    $reqHash | Out-File -FilePath $pipCachePath -NoNewline
    Write-Host "[OK] Dependencies installed" -ForegroundColor Green
} else {
    $cachedHash = Get-Content $pipCachePath -Raw
    if ($cachedHash -ne $reqHash) {
        Write-Host "[2/3] Updating changed dependencies..." -ForegroundColor Yellow
        & $venvPython -m pip install -r $backendReqFile
        if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: Failed to update dependencies" -ForegroundColor Red; exit 1 }
        
        $reqHash | Out-File -FilePath $pipCachePath -NoNewline
        Write-Host "[OK] Dependencies updated" -ForegroundColor Green
    } else {
        Write-Host "[2/3] Dependencies already installed (skipping)" -ForegroundColor Gray
    }
}

# Step 3: Start backend
Write-Host "[3/3] Starting backend server..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Backend running on: http://localhost:8000" -ForegroundColor Cyan
Write-Host "API Docs: http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop" -ForegroundColor Cyan
Write-Host ""

Set-Location $scriptDir
& $venvPython -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000 --log-level info
