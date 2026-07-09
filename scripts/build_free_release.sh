#!/bin/zsh
set -eu
set -o pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_VERSION="$(python3 - "${ROOT_DIR}/frontend/package.json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])
PY
)"
APP_PATH="${ROOT_DIR}/build/MedDRA Browser Mac.app"
MAC_ZIP="${ROOT_DIR}/build/meddra-browser-mac-app.zip"
MAC_VERSION_ZIP="${ROOT_DIR}/build/MedDRA-Browser-Mac-v${APP_VERSION}.zip"

cd "${ROOT_DIR}"

"${ROOT_DIR}/scripts/build_macos_app.sh" "${APP_PATH}"

rm -f "${MAC_ZIP}" "${MAC_VERSION_ZIP}"
ditto -c -k --sequesterRsrc --keepParent "${APP_PATH}" "${MAC_ZIP}"
cp "${MAC_ZIP}" "${MAC_VERSION_ZIP}"

"${ROOT_DIR}/scripts/build_portable_package.sh"

python3 - "${APP_PATH}" "${MAC_ZIP}" "${MAC_VERSION_ZIP}" "${ROOT_DIR}/build/meddra-browser-portable.zip" "${ROOT_DIR}/build/MedDRA-Browser-Windows-Emergency-v${APP_VERSION}.zip" <<'PY'
from __future__ import annotations

import sys
import zipfile
import getpass
from pathlib import Path

targets = [Path(arg) for arg in sys.argv[1:]]
forbidden_suffixes = (".asc", ".sqlite", ".sqlite-shm", ".sqlite-wal", ".pyc")
forbidden_names = {"__pycache__", "node_modules", ".git", ".env", "direct_url.json"}
home_markers = {
    str(Path.home()).encode(),
    f"\\Users\\{getpass.getuser()}".encode(),
}


def check_name(name: str) -> str | None:
    parts = set(Path(name).parts)
    if any(part in forbidden_names for part in parts):
        return name
    if name.endswith(forbidden_suffixes):
        return name
    return None


def check_bytes(name: str, data: bytes) -> str | None:
    if any(marker and marker in data for marker in home_markers):
        return name
    return None


def scan_tree(root: Path) -> tuple[list[str], list[str]]:
    bad_names: list[str] = []
    bad_content: list[str] = []
    for path in root.rglob("*"):
        rel = path.relative_to(root).as_posix()
        if check_name(rel):
            bad_names.append(rel)
        if path.is_file() and path.stat().st_size <= 2_000_000:
            try:
                data = path.read_bytes()
            except OSError:
                continue
            if check_bytes(rel, data):
                bad_content.append(rel)
    return bad_names, bad_content


def scan_zip(path: Path) -> tuple[list[str], list[str]]:
    bad_names: list[str] = []
    bad_content: list[str] = []
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if check_name(info.filename):
                bad_names.append(info.filename)
            if not info.is_dir() and info.file_size <= 2_000_000:
                data = zf.read(info.filename)
                if check_bytes(info.filename, data):
                    bad_content.append(info.filename)
    return bad_names, bad_content


failed = False
for target in targets:
    if not target.exists():
        print(f"Missing release artifact: {target}", file=sys.stderr)
        failed = True
        continue
    bad_names, bad_content = scan_zip(target) if target.suffix == ".zip" else scan_tree(target)
    if bad_names or bad_content:
        failed = True
        print(f"Release hygiene failed for {target}:", file=sys.stderr)
        for item in bad_names[:20]:
            print(f"  forbidden file: {item}", file=sys.stderr)
        for item in bad_content[:20]:
            print(f"  local path content: {item}", file=sys.stderr)

if failed:
    raise SystemExit(1)

print("发布包卫生检查通过：未发现词典原始文件、SQLite缓存、Python缓存、node_modules、.git、.env、direct_url.json 或当前构建用户路径。")
PY

echo
echo "无 Apple Developer Program 的分发包已生成："
echo "- ${MAC_ZIP}"
echo "- ${MAC_VERSION_ZIP}"
echo "- ${ROOT_DIR}/build/meddra-browser-portable.zip"
echo "- ${ROOT_DIR}/build/MedDRA-Browser-Windows-Emergency-v${APP_VERSION}.zip"
echo
echo "这些包未经过 Apple Developer ID 签名/公证，也不能上传 Mac App Store。"
echo "Mac 用户首次打开时可能需要右键 App 选择“打开”。"
