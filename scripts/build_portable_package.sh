#!/bin/zsh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="${ROOT_DIR}/build/portable/meddra-browser-portable"
ZIP_PATH="${ROOT_DIR}/build/meddra-browser-portable.zip"
APP_VERSION="$(python3 - "${ROOT_DIR}/frontend/package.json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])
PY
)"
WINDOWS_EMERGENCY_ZIP="${ROOT_DIR}/build/MedDRA-Browser-Windows-Emergency-v${APP_VERSION}.zip"
WINDOWS_PYTHON_VERSION="${WINDOWS_PYTHON_VERSION:-3.13.14}"
WINDOWS_PYTHON_TAG="${WINDOWS_PYTHON_TAG:-313}"
WINDOWS_PYTHON_URL="${WINDOWS_PYTHON_URL:-https://www.python.org/ftp/python/${WINDOWS_PYTHON_VERSION}/python-${WINDOWS_PYTHON_VERSION}-amd64.exe}"
WINDOWS_RUNTIME_DIR="${ROOT_DIR}/build/windows_runtime/python-${WINDOWS_PYTHON_VERSION}"
WINDOWS_INSTALLER_PATH="${WINDOWS_RUNTIME_DIR}/python-${WINDOWS_PYTHON_VERSION}-amd64.exe"
WINDOWS_WHEELHOUSE_DIR="${WINDOWS_RUNTIME_DIR}/wheelhouse"

cd "${ROOT_DIR}"

(cd frontend && npm run build)

mkdir -p "${WINDOWS_RUNTIME_DIR}"
if [[ ! -s "${WINDOWS_INSTALLER_PATH}" ]]; then
  echo "Downloading Windows Python ${WINDOWS_PYTHON_VERSION} installer..."
  curl -fL --retry 3 --retry-delay 2 -o "${WINDOWS_INSTALLER_PATH}.tmp" "${WINDOWS_PYTHON_URL}"
  mv "${WINDOWS_INSTALLER_PATH}.tmp" "${WINDOWS_INSTALLER_PATH}"
fi

rm -rf "${WINDOWS_WHEELHOUSE_DIR}"
mkdir -p "${WINDOWS_WHEELHOUSE_DIR}"
python3 -m pip download \
  --dest "${WINDOWS_WHEELHOUSE_DIR}" \
  --platform win_amd64 \
  --python-version "${WINDOWS_PYTHON_TAG}" \
  --implementation cp \
  --abi "cp${WINDOWS_PYTHON_TAG}" \
  --only-binary=:all: \
  -r backend/requirements.txt

rm -rf "${PACKAGE_ROOT}" "${ZIP_PATH}" "${WINDOWS_EMERGENCY_ZIP}"
mkdir -p \
  "${PACKAGE_ROOT}/backend" \
  "${PACKAGE_ROOT}/frontend" \
  "${PACKAGE_ROOT}/scripts" \
  "${PACKAGE_ROOT}/tools/python/windows" \
  "${PACKAGE_ROOT}/wheelhouse"

cp -R backend/app "${PACKAGE_ROOT}/backend/app"
find "${PACKAGE_ROOT}/backend/app" -name "__pycache__" -type d -prune -exec rm -rf {} +
cp backend/requirements.txt "${PACKAGE_ROOT}/backend/requirements.txt"
cp -R frontend/dist "${PACKAGE_ROOT}/frontend/dist"
cp scripts/start_meddra_server.sh "${PACKAGE_ROOT}/scripts/start_meddra_server.sh"
cp scripts/run_portable_server.py "${PACKAGE_ROOT}/scripts/run_portable_server.py"
cp start_windows.bat "${PACKAGE_ROOT}/start_windows.bat"
cp portable-index.html "${PACKAGE_ROOT}/index.html"
cp portable-index.html "${PACKAGE_ROOT}/第二步：双击我开始MedDRA浏览.html"
cp README.md "${PACKAGE_ROOT}/README.md"
cp LICENSE.md "${PACKAGE_ROOT}/LICENSE.md"
cp "${WINDOWS_INSTALLER_PATH}" "${PACKAGE_ROOT}/tools/python/windows/python-installer.exe"
cp -R "${WINDOWS_WHEELHOUSE_DIR}/." "${PACKAGE_ROOT}/wheelhouse/"

cat > "${PACKAGE_ROOT}/tools/python/windows/README.txt" <<TXT
This folder contains the official Windows x64 Python ${WINDOWS_PYTHON_VERSION} installer downloaded from:
${WINDOWS_PYTHON_URL}

The Windows launcher installs it only into the portable package folder:
.python_windows

It does not add Python to the system PATH and does not install for all users.
TXT

cp start_windows.bat "${PACKAGE_ROOT}/【Windows】第一步：请双击我运行.bat"
perl -0pi -e 's/\r?\n/\r\n/g' "${PACKAGE_ROOT}/start_windows.bat" "${PACKAGE_ROOT}/【Windows】第一步：请双击我运行.bat"
cat > "${PACKAGE_ROOT}/【Mac】第一步：请双击我运行.command" <<'CMD'
#!/bin/zsh
set -eu
cd "$(dirname "$0")"
./scripts/start_meddra_server.sh
CMD

cat > "${PACKAGE_ROOT}/请先看我.txt" <<'TXT'
使用顺序：

Windows：
1. 双击【Windows】第一步：请双击我运行.bat
2. 第一次运行会在本文件夹下准备 .python_windows 和 .venv_windows，不需要你单独安装 Python
3. 第一运行窗口会在服务启动后自动打开页面；如果没有自动打开，再双击 第二步：双击我开始MedDRA浏览.html

Mac：
1. 双击【Mac】第一步：请双击我运行.command
2. 第一运行窗口会在服务启动后自动打开页面；如果没有自动打开，再双击 第二步：双击我开始MedDRA浏览.html

打开页面后，如果系统提示还没有词典，请点“选择词典文件夹”，在文件管理器或 Finder 里选择你的 MedDRA 文件夹。可以选 MedDRA_29_0_Chinese、MedDRA_29_0_English、MedAscii、ascii-290，或者它们的上级文件夹。
使用时请保持第一步打开的窗口不要关闭；不用时关闭窗口即可停止服务。
TXT

chmod +x "${PACKAGE_ROOT}/scripts/start_meddra_server.sh"
chmod +x "${PACKAGE_ROOT}/【Mac】第一步：请双击我运行.command"

mkdir -p "$(dirname "${ZIP_PATH}")"
make_zip() {
  local target_zip="$1"
  python3 - "${PACKAGE_ROOT}" "${target_zip}" <<'PY'
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

package_root = Path(sys.argv[1])
zip_path = Path(sys.argv[2])
base = package_root.parent

with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(package_root.rglob("*")):
        if path.is_file():
            zf.write(path, path.relative_to(base).as_posix())
PY
}

make_zip "${ZIP_PATH}"
make_zip "${WINDOWS_EMERGENCY_ZIP}"
echo "${ZIP_PATH}"
echo "${WINDOWS_EMERGENCY_ZIP}"
