#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ "${MEDDRA_FRONTEND_PREBUILT:-0}" != 1 ]]; then
  (cd frontend && npm run build)
fi

mkdir -p build
STAGING="$(mktemp -d "$ROOT/build/.portable.XXXXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
PACKAGE="$STAGING/meddra-browser-portable"
scripts/copy_bundle_payload.sh "$PACKAGE"
cp scripts/start_meddra_server.sh "$PACKAGE/scripts/"
# cmd.exe requires stable line endings and parses startup scripts before
# Python can select UTF-8. Keep the batch commands ASCII and emit DOS lines.
python3 - "$PACKAGE/【Windows】第一步：请双击我运行.bat" <<'PYBAT'
from pathlib import Path
import sys

source = Path("start_windows.bat").read_text(encoding="ascii")
Path(sys.argv[1]).write_bytes(source.replace("\n", "\r\n").encode("ascii"))
PYBAT
cp portable-index.html "$PACKAGE/第二步：双击我开始MedDRA浏览.html"
cp README.md "$PACKAGE/"
python3 scripts/build_runtime.py "$PACKAGE/tools/python" macos-arm64 macos-x86_64 windows-x86_64

cat > "$PACKAGE/【Mac】第一步：请双击我运行.command" <<'COMMAND'
#!/bin/zsh
set -eu
root="$(cd "$(dirname "$0")" && pwd)"
exec "$root/scripts/start_meddra_server.sh"
COMMAND
chmod +x "$PACKAGE/【Mac】第一步：请双击我运行.command" "$PACKAGE/scripts/start_meddra_server.sh"

cat > "$PACKAGE/请先看我.txt" <<'GUIDE'
MedDRA Browser 便携版

1. 完整解压 ZIP 到可写文件夹。
2. 双击与你电脑对应的第一步启动文件。Mac 需 macOS 12 或更新版本，Windows 需 64 位 Windows 10/11。
3. 启动后会自动打开浏览器。如果页面没有打开，用第二步 HTML 或复制启动窗口中的地址。
4. 在「设置」里选择你已获授权的 MedDRA 词典文件夹。首次建索引可以在界面中查看进度。
5. 导出需要保留的审阅结果，再点「退出便携版」，或在启动窗口按 Ctrl+C。

完整解压后的包自带 Python 与所需依赖，首次使用也可离线。包内不含词典。
换电脑或移动文件夹时，原来配置的外部词典路径可能要重选。Windows 上应先解压到本地磁盘。
GUIDE

# zipfile preserves the Mac executables and writes UTF-8 filenames for Explorer.
/usr/bin/env python3 - "$PACKAGE" "$STAGING/meddra-browser-portable.zip" <<'PY'
from pathlib import Path
import sys
import zipfile

root, target = map(Path, sys.argv[1:])
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=5) as bundle:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            bundle.write(path, path.relative_to(root.parent).as_posix())
PY
mv "$STAGING/meddra-browser-portable.zip" "$ROOT/build/meddra-browser-portable.zip"
echo "$ROOT/build/meddra-browser-portable.zip"
