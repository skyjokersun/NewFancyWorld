@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set "QIYU_HOST=127.0.0.1"
set "QIYU_ADMIN_HOST=127.0.0.1"
set "QIYU_PORT=14514"
set "QIYU_ADMIN_PORT=19810"
set "QIYU_DEV=1"
node src\index.js
pause
