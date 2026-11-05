@echo off
chcp 65001 >nul
cd /d "%~dp0"
:start
node src\index.js
rem 75 = restarted from the admin page: start again
if %errorlevel%==75 goto start
pause
