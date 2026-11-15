@echo off
rem Builds dist\StickyNotes.exe (one portable file). Needs Node.js 22.12 or newer.
cd /d "%~dp0"
if not exist node_modules call npm ci || exit /b 1
call npm test || exit /b 1
call npm run dist || exit /b 1
echo.
echo Built: %~dp0dist\StickyNotes.exe
