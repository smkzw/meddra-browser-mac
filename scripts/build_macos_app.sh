#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP_NAME="${MEDDRA_APP_NAME:-MedDRA Browser Mac}"
APP_PATH="${1:-$ROOT/build/$APP_NAME.app}"
APP_VERSION="${MEDDRA_APP_VERSION:-$(node -p 'require("./frontend/package.json").version')}"
APP_BUILD_NUMBER="${MEDDRA_BUILD_NUMBER:-$(git rev-list --count HEAD)}"
BUNDLE_ID="${MEDDRA_BUNDLE_ID:-local.meddra.browser.mac}"
APP_STORE_MODE="${MEDDRA_APP_STORE_MODE:-0}"
if [[ "$APP_PATH" != *.app || -L "$APP_PATH" ]]; then
  echo "Expected a regular .app destination: $APP_PATH" >&2
  exit 1
fi

if [[ "${MEDDRA_FRONTEND_PREBUILT:-0}" != 1 ]]; then
  (cd frontend && npm run build)
fi

mkdir -p "$(dirname "$APP_PATH")"
STAGING="$(mktemp -d "$(dirname "$APP_PATH")/.meddra-app.XXXXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
STAGED_APP="$STAGING/$APP_NAME.app"
CONTENTS="$STAGED_APP/Contents"
PAYLOAD="$CONTENTS/Resources/app"
mkdir -p "$CONTENTS/MacOS"
scripts/copy_bundle_payload.sh "$PAYLOAD"
python3 scripts/build_runtime.py "$PAYLOAD/tools/python" macos-arm64 macos-x86_64

xcrun swiftc -swift-version 5 -O -target arm64-apple-macosx12.0 mac/MedDRAApp.swift -o "$STAGING/arm64"
xcrun swiftc -swift-version 5 -O -target x86_64-apple-macosx12.0 mac/MedDRAApp.swift -o "$STAGING/x86_64"
xcrun lipo -create "$STAGING/arm64" "$STAGING/x86_64" -output "$CONTENTS/MacOS/MedDRA"

python3 - "$CONTENTS/Info.plist" "$APP_NAME" "$APP_VERSION" "$APP_BUILD_NUMBER" "$BUNDLE_ID" "$APP_STORE_MODE" <<'PY'
import plistlib
import sys
from pathlib import Path

path, name, version, build, bundle_id, store_mode = sys.argv[1:]
Path(path).write_bytes(plistlib.dumps({
    "CFBundleName": name,
    "CFBundleDisplayName": name,
    "CFBundleExecutable": "MedDRA",
    "CFBundleIdentifier": bundle_id,
    "CFBundleIconFile": "AppIcon",
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": version,
    "CFBundleVersion": build,
    "CFBundleDevelopmentRegion": "zh_CN",
    "LSApplicationCategoryType": "public.app-category.medical",
    "LSMinimumSystemVersion": "12.0",
    "NSHighResolutionCapable": True,
    "NSDocumentsFolderUsageDescription": "读取你选择的 MedDRA 词典和待编码文件。",
    "NSDownloadsFolderUsageDescription": "读取你选择的词典或保存导出的文件。",
    "MedDRAAppStoreCandidate": store_mode == "1",
}))
PY

ICONSET="$STAGING/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" frontend/public/brand/app-icon-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" frontend/public/brand/app-icon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"

# Sign the executable, runtime and libraries with local ad hoc signatures.
# Developer ID signing and notarization are separate distribution steps.
python3 - "$PAYLOAD/tools/python" <<'PY'
from pathlib import Path
import subprocess
import sys

magic = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe"}
for path in Path(sys.argv[1]).rglob("*"):
    if not path.is_file():
        continue
    with path.open("rb") as stream:
        if stream.read(4) not in magic:
            continue
    subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True, capture_output=True)
PY
codesign --force --sign - "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"

# A failed build leaves any previously installed app in place.
if [[ -e "$APP_PATH" ]]; then
  mv "$APP_PATH" "$STAGING/previous.app"
fi
if ! mv "$STAGED_APP" "$APP_PATH"; then
  if [[ -e "$STAGING/previous.app" ]]; then
    mv "$STAGING/previous.app" "$APP_PATH"
  fi
  exit 1
fi
echo "$APP_PATH"
