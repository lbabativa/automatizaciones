@echo off
REM Arranca el worker de automatizaciones en la clinica.
REM Debe correr en una sesion de escritorio abierta (no como servicio oculto),
REM porque Colsanitas exige un login manual la primera vez (Radware).
cd /d "%~dp0\.."
echo Iniciando worker de StartIA Automatizaciones...
call npm run worker
pause
