@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "SCRIPT_DIR=%~dp0"
set "HOST=127.0.0.1"
if "%MEDDRA_BROWSER_PORT%"=="" set "MEDDRA_BROWSER_PORT=8765"
set "PORT=%MEDDRA_BROWSER_PORT%"
set "PYTHONUTF8=1"
set "LOCAL_PYTHON=%SCRIPT_DIR%.python_windows\python.exe"
set "PYTHON_INSTALLER=%SCRIPT_DIR%tools\python\windows\python-installer.exe"
set "PYTHON_EXE="
set "PYTHON_ARGS="
set "USING_BUNDLED_PYTHON=0"
set "USE_OFFLINE_WHEELHOUSE=0"

if exist "%LOCAL_PYTHON%" (
  set "PYTHON_EXE=%LOCAL_PYTHON%"
  set "USING_BUNDLED_PYTHON=1"
  goto :python_ready
)

if exist "%PYTHON_INSTALLER%" (
  call :install_bundled_python
  if errorlevel 1 goto :python_unavailable
  set "PYTHON_EXE=%LOCAL_PYTHON%"
  set "USING_BUNDLED_PYTHON=1"
  goto :python_ready
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PYTHON_EXE=py"
  set "PYTHON_ARGS=-3"
  goto :python_ready
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PYTHON_EXE=python"
  goto :python_ready
)

:python_unavailable
echo 未找到可用的 Python 3.9 或更新版本，也没有找到包内 Windows Python 安装器。
echo No usable Python 3.9+ runtime or bundled Windows Python installer was found.
echo 请重新下载最新版 MedDRA Browser 便携包，或手动安装 Python 3.9+ 后再运行本文件。
pause
exit /b 1

:python_ready
call :check_python_version
if errorlevel 1 (
  if exist "%PYTHON_INSTALLER%" (
    echo 检测到当前 Python 低于 3.9，正在改用包内 Windows Python 运行环境...
    call :install_bundled_python
    if errorlevel 1 goto :python_unavailable
    set "PYTHON_EXE=%LOCAL_PYTHON%"
    set "PYTHON_ARGS="
    set "USING_BUNDLED_PYTHON=1"
    call :check_python_version
    if errorlevel 1 goto :python_too_old
  ) else (
    goto :python_too_old
  )
)

if not exist ".venv_windows\Scripts\python.exe" (
  echo 正在准备本地 Python 虚拟环境...
  "%PYTHON_EXE%" %PYTHON_ARGS% -m venv .venv_windows
  if errorlevel 1 (
    echo 创建 .venv_windows 失败。
    pause
    exit /b 1
  )
)

echo 正在检查后端依赖...
if "%USING_BUNDLED_PYTHON%"=="1" if exist "wheelhouse\*.whl" set "USE_OFFLINE_WHEELHOUSE=1"
if "%USE_OFFLINE_WHEELHOUSE%"=="1" (
  echo 使用包内离线依赖包安装。
  ".venv_windows\Scripts\python.exe" -m pip install --no-index --find-links "%SCRIPT_DIR%wheelhouse" -r backend\requirements.txt
  if errorlevel 1 (
    echo 包内离线依赖安装失败，正在尝试联网安装。
    ".venv_windows\Scripts\python.exe" -m pip install -r backend\requirements.txt
  )
) else (
  echo 未找到包内离线依赖包，改为联网安装。
  ".venv_windows\Scripts\python.exe" -m pip install -r backend\requirements.txt
)
if errorlevel 1 (
  echo 后端依赖安装失败。
  pause
  exit /b 1
)

set "PYTHONPATH=%SCRIPT_DIR%backend"

echo 正在启动 MedDRA Browser: http://%HOST%:%PORT%/
echo 使用时请保持这个窗口打开；不用时关闭窗口即可。
".venv_windows\Scripts\python.exe" scripts\run_portable_server.py

pause
exit /b %ERRORLEVEL%

:install_bundled_python
echo 正在准备包内 Windows Python 运行环境，仅安装到本文件夹下的 .python_windows。
"%PYTHON_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 Include_pip=1 TargetDir="%SCRIPT_DIR%.python_windows"
if errorlevel 1 (
  echo 包内 Windows Python 安装失败。
  exit /b 1
)
if not exist "%LOCAL_PYTHON%" (
  echo 包内 Windows Python 安装后仍未找到 python.exe。
  exit /b 1
)
exit /b 0

:check_python_version
"%PYTHON_EXE%" %PYTHON_ARGS% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

:python_too_old
echo 当前 Python 版本低于 3.9。MedDRA Browser 当前支持 Python 3.9 或更新版本。
echo The current Python is older than 3.9. MedDRA Browser requires Python 3.9 or later.
pause
exit /b 1
