@echo off
REM Doble clic: crea el acceso directo "Robot StartIA" en el escritorio.
REM Pregunta si tambien debe arrancar solo al iniciar Windows.
setlocal
echo.
echo   Crear acceso directo del Robot StartIA
echo.
choice /c SN /m "Tambien arrancar el robot al iniciar sesion en Windows"
if errorlevel 2 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0crear-acceso-directo.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0crear-acceso-directo.ps1" -AlIniciarWindows
)
echo.
pause
