# TFS Agent Hub - Build Script
# This script bundles the entire project into a single .exe for server deployment

Write-Host "🚀 Starting TFS Agent Hub Packaging Process..." -ForegroundColor Cyan

# 1. Install/Update PyInstaller
Write-Host "📦 Installing/Updating PyInstaller..." -ForegroundColor Green
pip install pyinstaller requests_ntlm openpyxl uvicorn

# 2. Build the EXE
# --onefile: Create a single executable
# --add-data: Include frontend files and agents inside the EXE
# --hidden-import: Ensure dynamic imports like uvicorn are captured
Write-Host "🔨 Bundling into EXE (this may take a minute)..." -ForegroundColor Green
pyinstaller --name "TFS-Agent-Hub" `
    --onefile `
    --add-data "frontend;frontend" `
    --add-data "backend/agents;backend/agents" `
    --hidden-import "uvicorn.logging" `
    --hidden-import "uvicorn.loops" `
    --hidden-import "uvicorn.loops.auto" `
    --hidden-import "uvicorn.protocols" `
    --hidden-import "uvicorn.protocols.http" `
    --hidden-import "uvicorn.protocols.http.auto" `
    --hidden-import "uvicorn.protocols.websockets" `
    --hidden-import "uvicorn.protocols.websockets.auto" `
    --hidden-import "uvicorn.lifespan" `
    --hidden-import "uvicorn.lifespan.on" `
    backend/main.py

Write-Host "`n✅ BUILD COMPLETE!" -ForegroundColor Cyan
Write-Host "📍 Your setup file is located at: " -NoNewline
Write-Host "dist/TFS-Agent-Hub.exe" -ForegroundColor Yellow
Write-Host "`n🚀 How to deploy:"
Write-Host "1. Copy 'TFS-Agent-Hub.exe' to your server."
Write-Host "2. Double-click to run."
Write-Host "3. Share this link with teammates: http://SERVER-IP:8000"
