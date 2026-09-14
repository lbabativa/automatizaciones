@echo off
REM Robot StartIA: arranca el worker de automatizaciones en este PC.
REM Debe correr en una sesion de escritorio abierta (no como servicio oculto),
REM porque algunos portales, como Colsanitas, piden iniciar sesion a mano la primera vez.
REM Si el robot se cierra por un error, se reinicia solo a los 30 segundos.
setlocal
title Robot StartIA
cd /d "%~dp0\.."

where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instalelo desde https://nodejs.org y vuelva a abrir el robot.
  pause
  exit /b 1
)
if not exist ".env.local" (
  echo Falta el archivo .env.local en %cd%
  echo Copielo en esa carpeta antes de iniciar el robot.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Instalando dependencias por primera vez, puede tardar unos minutos...
  call npm install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

:iniciar
cls
echo.
echo   ROBOT STARTIA - AUTOMATIZACIONES
echo   Carpeta: %cd%
echo.
echo   Deje esta ventana abierta (puede minimizarla) mientras el robot trabaja.
echo   Para detenerlo: Ctrl+C y luego S.
echo.
call npm run worker
if errorlevel 1 (
  echo.
  echo El robot se cerro por un error. Se reinicia en 30 segundos.
  echo Para no reiniciarlo, cierre esta ventana.
  timeout /t 30 >nul
  goto iniciar
)
echo.
echo El robot se detuvo.
pause
