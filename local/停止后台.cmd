@echo off
powershell.exe -NoProfile -Command "Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:18765/api/shutdown' -ContentType 'application/json' -Body '{}'"
if errorlevel 1 pause
