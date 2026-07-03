#!/bin/zsh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_NAME="MedDRA Browser Mac"
APP_PATH="${1:-${ROOT_DIR}/build/${APP_NAME}.app}"

if [[ "${APP_PATH}" != *.app ]]; then
  echo "Target must end with .app: ${APP_PATH}" >&2
  exit 1
fi

APP_PARENT="$(dirname "${APP_PATH}")"
CONTENTS_DIR="${APP_PATH}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
PAYLOAD_DIR="${RESOURCES_DIR}/app"

(cd "${ROOT_DIR}/frontend" && npm run build)

rm -rf "${APP_PATH}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}" "${PAYLOAD_DIR}/backend" "${PAYLOAD_DIR}/frontend" "${PAYLOAD_DIR}/vendor"

cp -R "${ROOT_DIR}/backend/app" "${PAYLOAD_DIR}/backend/app"
cp "${ROOT_DIR}/backend/requirements.txt" "${PAYLOAD_DIR}/backend/requirements.txt"
cp -R "${ROOT_DIR}/frontend/dist" "${PAYLOAD_DIR}/frontend/dist"

find "${PAYLOAD_DIR}" -name "__pycache__" -type d -prune -exec rm -rf {} +
find "${PAYLOAD_DIR}" -name "*.pyc" -delete

python3 - "${PAYLOAD_DIR}/vendor" <<'PY'
from __future__ import annotations

import importlib.metadata as metadata
import platform
import re
import shutil
import sys
from pathlib import Path
from packaging.requirements import Requirement

vendor = Path(sys.argv[1])
roots = ["fastapi", "uvicorn", "openpyxl"]
seen: set[str] = set()
queue = list(roots)

def normalized(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()

while queue:
    name = queue.pop(0)
    key = normalized(name)
    if key in seen:
        continue
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError as exc:
        raise SystemExit(f"Required Python package is not installed: {name}") from exc
    seen.add(normalized(dist.metadata["Name"]))
    for requirement in dist.requires or []:
        parsed = Requirement(requirement)
        if parsed.marker and not parsed.marker.evaluate():
            continue
        dep = parsed.name
        if normalized(dep) not in seen:
            queue.append(dep)

for key in sorted(seen):
    dist = metadata.distribution(key)
    for item in dist.files or []:
        if item.is_absolute() or ".." in item.parts or "__pycache__" in item.parts:
            continue
        source = Path(dist.locate_file(item))
        if not source.exists() or source.is_dir() or source.suffix == ".pyc":
            continue
        target = vendor / item
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

(vendor / ".python-version").write_text(f"{sys.version_info.major}.{sys.version_info.minor}\n", encoding="utf-8")
(vendor / ".python-arch").write_text(f"{platform.machine()}\n", encoding="utf-8")
for record in vendor.glob("*.dist-info/RECORD"):
    try:
        lines = record.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        continue
    clean = [
        line
        for line in lines
        if "/Users/" not in line
        and "\\Users\\" not in line
        and ".pyc" not in line
        and "Caches/com.apple.python" not in line
    ]
    record.write_text("\n".join(clean) + ("\n" if clean else ""), encoding="utf-8")
for direct_url in vendor.glob("*.dist-info/direct_url.json"):
    direct_url.unlink()
print(f"Vendored {len(seen)} Python distributions into {vendor}")
PY

cat > "${CONTENTS_DIR}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleExecutable</key>
  <string>MedDRA Browser Mac</string>
  <key>CFBundleIdentifier</key>
  <string>local.meddra.browser.mac</string>
  <key>CFBundleName</key>
  <string>MedDRA Browser Mac</string>
  <key>CFBundleDisplayName</key>
  <string>MedDRA Browser Mac</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.8</string>
  <key>CFBundleVersion</key>
  <string>8</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

cp "${ROOT_DIR}/frontend/public/brand/app-icon-512.png" "${RESOURCES_DIR}/AppIcon.png"
ICON_TMP="$(mktemp -d)"
ICONSET="${ICON_TMP}/AppIcon.iconset"
mkdir -p "${ICONSET}"
for item in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  size="${item%% *}"
  name="${item#* }"
  sips -z "${size}" "${size}" "${ROOT_DIR}/frontend/public/brand/app-icon-512.png" --out "${ICONSET}/${name}" >/dev/null
done
iconutil -c icns "${ICONSET}" -o "${RESOURCES_DIR}/AppIcon.icns"
rm -rf "${ICON_TMP}"

cat > "${MACOS_DIR}/MedDRA Browser Mac" <<'LAUNCHER'
#!/bin/zsh
set -u

APP_CONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="${APP_CONTENTS_DIR}/Resources/app"
SUPPORT_DIR="${HOME}/Library/Application Support/MedDRA Browser Mac"
DATA_DIR="${SUPPORT_DIR}/data"
LOG_DIR="${HOME}/Library/Logs/MedDRA Browser Mac"
SERVER_LOG="${LOG_DIR}/server.log"
PID_FILE="${SUPPORT_DIR}/server.pid"
VENDOR_DIR="${APP_ROOT}/vendor"
HOST="127.0.0.1"
PORT="${MEDDRA_BROWSER_PORT:-8765}"
URL="http://${HOST}:${PORT}/"

mkdir -p "${DATA_DIR}" "${LOG_DIR}"
touch "${SERVER_LOG}"

notify() {
  osascript -e "display notification \"$1\" with title \"MedDRA Browser Mac\"" >/dev/null 2>&1 || true
}

fail() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"MedDRA Browser Mac\"" >/dev/null 2>&1 || true
  open "${SERVER_LOG}" >/dev/null 2>&1 || true
  exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
  fail "未找到 python3。请先安装 Python 3.9 或更新版本，然后重新打开 App。"
fi

VENDOR_PY="$(cat "${VENDOR_DIR}/.python-version" 2>/dev/null || true)"
VENDOR_ARCH="$(cat "${VENDOR_DIR}/.python-arch" 2>/dev/null || true)"
typeset -a PYTHON_CMD
PYTHON_CMD=(python3)

if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  if [ "${VENDOR_ARCH}" = "arm64" ]; then
    PYTHON_CMD=(/usr/bin/arch -arm64 python3)
  elif [ "${VENDOR_ARCH}" = "x86_64" ]; then
    PYTHON_CMD=(/usr/bin/arch -x86_64 python3)
  fi
fi

RUNTIME_INFO="$("${PYTHON_CMD[@]}" - <<'PY'
import platform
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}|{platform.machine()}")
PY
)"
RUNTIME_PY="${RUNTIME_INFO%%|*}"
RUNTIME_ARCH="${RUNTIME_INFO#*|}"
if [ "${RUNTIME_PY}" != "${VENDOR_PY}" ] || [ "${RUNTIME_ARCH}" != "${VENDOR_ARCH}" ]; then
  fail "当前 python3 为 ${RUNTIME_PY}/${RUNTIME_ARCH}，但此 App 内置依赖为 ${VENDOR_PY}/${VENDOR_ARCH}。请用当前机器重新运行 scripts/build_macos_app.sh 构建 App。"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] python=${PYTHON_CMD[*]} runtime=${RUNTIME_PY}/${RUNTIME_ARCH} vendor=${VENDOR_PY}/${VENDOR_ARCH}" >> "${SERVER_LOG}"

export MEDDRA_BROWSER_STATE_DIR="${DATA_DIR}"
export PYTHONPATH="${VENDOR_DIR}:${APP_ROOT}/backend"

if ! curl -fsS --max-time 1 "http://${HOST}:${PORT}/api/source-roots" >/dev/null 2>&1; then
  notify "正在启动本地 MedDRA Browser 服务..."
  (
    cd "${APP_ROOT}"
    nohup "${PYTHON_CMD[@]}" -m uvicorn app.main:app --host "${HOST}" --port "${PORT}" >> "${SERVER_LOG}" 2>&1 &
    echo "$!" > "${PID_FILE}"
  )
fi

for _ in {1..90}; do
  if curl -fsS --max-time 1 "http://${HOST}:${PORT}/api/source-roots" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS --max-time 1 "http://${HOST}:${PORT}/api/source-roots" >/dev/null 2>&1; then
  fail "本地服务启动失败。日志会自动打开。"
fi

if [ "${MEDDRA_BROWSER_OPEN:-1}" = "0" ]; then
  exit 0
fi

maximize_browser_window() {
  local app_name="$1"
  (
    sleep 1.2
    osascript <<OSA
tell application "System Events"
  if exists process "${app_name}" then
    tell process "${app_name}"
      set frontmost to true
      repeat 20 times
        if (count of windows) > 0 then exit repeat
        delay 0.2
      end repeat
      if (count of windows) > 0 then
        try
          set zoomed of window 1 to true
        on error
          try
            tell application "Finder" to set desktopBounds to bounds of window of desktop
            set {leftEdge, topEdge, rightEdge, bottomEdge} to desktopBounds
            set position of window 1 to {leftEdge + 20, topEdge + 40}
            set size of window 1 to {(rightEdge - leftEdge) - 40, (bottomEdge - topEdge) - 80}
          end try
        end try
      end if
    end tell
  end if
end tell
OSA
  ) >/dev/null 2>&1 &!
}

if [ -d "/Applications/Microsoft Edge.app" ]; then
  open -na "Microsoft Edge" --args --start-maximized --app="${URL}"
  maximize_browser_window "Microsoft Edge"
elif [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --start-maximized --app="${URL}"
  maximize_browser_window "Google Chrome"
else
  open "${URL}"
fi
LAUNCHER

chmod +x "${MACOS_DIR}/MedDRA Browser Mac"
xattr -cr "${APP_PATH}" >/dev/null 2>&1 || true

mkdir -p "${APP_PARENT}"
echo "${APP_PATH}"
