@echo off
cd /d "%~dp0"
python server.py --open
if errorlevel 1 (
  echo Python 3.10+ is required. Offline mode: open index.html directly.
  pause
)
