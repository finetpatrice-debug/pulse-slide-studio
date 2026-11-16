@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==================================================================
echo   INSTALLATION ET LANCEMENT DE PULSE SLIDE STUDIO (POWERPOINT)
echo ==================================================================
if not exist "node_modules" (
    echo Installation des dependances Node.js...
    call npm.cmd install
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-ppt-ribbon.ps1"
pause
