<#
.SYNOPSIS
  Crea el acceso directo "Robot StartIA" para arrancar el worker con doble clic.

.DESCRIPTION
  Pone el acceso directo en el escritorio del usuario y, con -AlIniciarWindows, tambien en la
  carpeta de inicio para que el robot arranque solo al iniciar sesion. El acceso directo abre
  worker\start-worker.cmd con el icono worker\robot-startia.ico.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File worker\crear-acceso-directo.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File worker\crear-acceso-directo.ps1 -AlIniciarWindows
#>
param(
  [switch]$AlIniciarWindows,
  [string]$Destino = [Environment]::GetFolderPath('Desktop')
)
$ErrorActionPreference = 'Stop'

$carpetaWorker = $PSScriptRoot
$lanzador = Join-Path $carpetaWorker 'start-worker.cmd'
$icono = Join-Path $carpetaWorker 'robot-startia.ico'
if (-not (Test-Path $lanzador)) { throw "No se encontro el lanzador: $lanzador" }

$shell = New-Object -ComObject WScript.Shell

function Crear-Acceso([string]$carpeta) {
  if (-not (Test-Path $carpeta)) { New-Item -ItemType Directory -Force -Path $carpeta | Out-Null }
  $ruta = Join-Path $carpeta 'Robot StartIA.lnk'
  $acceso = $shell.CreateShortcut($ruta)
  $acceso.TargetPath = $lanzador
  $acceso.WorkingDirectory = Split-Path $carpetaWorker -Parent
  $acceso.Description = 'Inicia el robot de StartIA Automatizaciones en este PC'
  $acceso.WindowStyle = 1
  if (Test-Path $icono) { $acceso.IconLocation = "$icono,0" }
  $acceso.Save()
  Write-Host "Acceso directo creado: $ruta"
}

Crear-Acceso $Destino
if ($AlIniciarWindows) { Crear-Acceso ([Environment]::GetFolderPath('Startup')) }
