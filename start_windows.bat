@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0" || goto :failed

set "RUNTIME=tools\python\windows-x86_64\python.exe"
if not exist "%RUNTIME%" (
  echo 包内 Windows x64 运行时缺失。请完整解压便携版 ZIP 后重试。
  goto :failed
)

"%RUNTIME%" -I -B -X utf8 scripts\run_portable_server.py
if errorlevel 1 goto :failed
exit /b 0

:failed
echo 启动失败。请检查上方信息，并确认当前目录可写。
pause
exit /b 1
