@echo off
cd /d "%~dp0"
if not exist venv\Scripts\python.exe (
  echo Python virtual environment not found.
  echo Create it with: python -m venv venv
  pause
  exit /b 1
)
venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
