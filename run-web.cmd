@echo off
rem Starts the website dev server and opens it in your browser.
cd /d "%~dp0"
if not exist node_modules (call npm install || exit /b 1)
call npm run dev -- --open
