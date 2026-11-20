@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0" || goto :failed

set "RUNTIME=tools\python\windows-x86_64\python.exe"
if not exist "%RUNTIME%" (
  echo Bundled Windows x64 runtime is missing. Extract the entire portable ZIP and retry.
  goto :failed
)

"%RUNTIME%" -I -B -X utf8 scripts\run_portable_server.py
if errorlevel 1 goto :failed
exit /b 0

:failed
echo Startup failed. Check the message above and make sure this folder is writable.
pause
exit /b 1
