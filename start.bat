@echo off
echo Starting OpenCLAW Service...
cd /d "%~dp0"
start "OpenCLAW" cmd /k "node openclaw-service.js"
echo Service started!
timeout /t 3 /nobreak >nul
start http://localhost:18888
