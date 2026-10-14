@echo off
chcp 65001 >nul
title Vibloo
cd /d "%~dp0server"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Manca Node.js. Scaricalo da https://nodejs.org ^(versione LTS^), installalo
  echo   e poi fai di nuovo doppio clic su questo file.
  echo.
  start https://nodejs.org
  pause
  exit /b
)
if not exist node_modules (
  echo Prima installazione, attendi qualche secondo...
  call npm install --omit=dev --no-audit --no-fund
)
call npm start
pause
