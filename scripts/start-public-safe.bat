@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set "QIYU_HOST=0.0.0.0"
set "QIYU_PORT=14514"
set "QIYU_ADMIN_HOST=127.0.0.1"
set "QIYU_ADMIN_PORT=19810"
set "QIYU_DEV=0"
set "QIYU_DEV_EMAIL_CODE="
set "QIYU_ALLOW_REGISTER_WITHOUT_MAIL=0"
:restart
node src\index.js
if %errorlevel%==75 goto restart
pause
