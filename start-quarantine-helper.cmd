@echo off
chcp 65001 >nul
title Помощник карантина — FrDomianReview
cd /d "%~dp0"
node scripts\helper.mjs
echo.
pause
