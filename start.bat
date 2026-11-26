@echo off
chcp 65001 >nul
title MuseBatch Studio - Tao Video Hang Loat
cd /d "%~dp0"
echo Dang khoi dong MuseBatch Studio tai http://localhost:3456 ...
start "" http://localhost:3456
node server/index.js
pause
