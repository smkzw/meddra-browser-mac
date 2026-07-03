@echo off
setlocal

cd /d "%~dp0"

set HOST=127.0.0.1
if "%MEDDRA_BROWSER_PORT%"=="" set MEDDRA_BROWSER_PORT=8765
set PORT=%MEDDRA_BROWSER_PORT%
set PYTHONUTF8=1

if "%MEDDRA_SOURCE_ROOT%"=="" (
  if exist "%CD%\dictionaries" (
    set MEDDRA_SOURCE_ROOT=%CD%\dictionaries
  )
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set PYTHON_CMD=py -3
) else (
  where python >nul 2>nul
  if %ERRORLEVEL%==0 (
    set PYTHON_CMD=python
  ) else (
    echo Python 3 is required. Install Python 3.10 or later, then run this file again.
    pause
    exit /b 1
  )
)

if not exist ".venv_windows\Scripts\python.exe" (
  echo Creating local Python virtual environment...
  %PYTHON_CMD% -m venv .venv_windows
  if %ERRORLEVEL% neq 0 (
    echo Failed to create .venv_windows.
    pause
    exit /b 1
  )
)

echo Installing backend dependencies...
".venv_windows\Scripts\python.exe" -m pip install -r backend\requirements.txt
if %ERRORLEVEL% neq 0 (
  echo Dependency installation failed.
  pause
  exit /b 1
)

set PYTHONPATH=%CD%\backend

echo Starting MedDRA Browser at http://%HOST%:%PORT%/
echo Keep this window open while using the browser. Close it when you are done.
".venv_windows\Scripts\python.exe" scripts\run_portable_server.py

pause
