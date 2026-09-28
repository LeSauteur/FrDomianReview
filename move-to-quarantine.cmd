@echo off
chcp 65001 >nul
title Перенос отмеченных файлов в карантин
cd /d "%~dp0"
echo Беру решения из общего репозитория и показываю, что будет перенесено...
echo.
node scripts\quarantine.mjs --confirm
echo.
pause
