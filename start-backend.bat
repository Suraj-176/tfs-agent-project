@echo off
REM Start TFS Agent Backend
REM This script automatically handles venv activation and dependency installation

setlocal enabledelayedexpansion

cd /d "%~dp0"

echo.
echo ================================
echo TFS Agent Backend Startup
echo ================================
echo.

REM PowerShell is more reliable for this task, so delegate to it
powershell -NoProfile -ExecutionPolicy Bypass -File "start-backend.ps1"

if !errorlevel! neq 0 (
    echo.
    echo ERROR: Backend failed to start
    echo.
    pause
    exit /b !errorlevel!
)
