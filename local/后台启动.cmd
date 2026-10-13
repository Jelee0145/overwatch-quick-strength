@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -Command "$pythonPath=(Get-Command python -ErrorAction Stop).Source; Start-Process -FilePath $pythonPath -ArgumentList @('server.py','--open') -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"
if errorlevel 1 pause
