from __future__ import annotations

import os
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("MEDDRA_BROWSER_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEDDRA_BROWSER_PORT", "8765"))
BASE_URL = f"http://{HOST}:{PORT}/"
READY_URL = f"{BASE_URL}api/source-roots"
HTML_ENTRY = ROOT / "第二步：双击我开始MedDRA浏览.html"
FALLBACK_HTML_ENTRY = ROOT / "index.html"


def is_ready() -> bool:
    try:
        with urllib.request.urlopen(READY_URL, timeout=1.5) as response:
            return 200 <= response.status < 500
    except (OSError, urllib.error.URLError):
        return False


def open_entry() -> None:
    if os.environ.get("MEDDRA_BROWSER_OPEN", "1") == "0":
        return
    entry = HTML_ENTRY if HTML_ENTRY.exists() else FALLBACK_HTML_ENTRY
    if entry.exists():
        webbrowser.open(entry.resolve().as_uri())
    else:
        webbrowser.open(BASE_URL)


def wait_until_ready_and_open() -> None:
    for _ in range(120):
        if is_ready():
            print(f"MedDRA Browser 已启动：{BASE_URL}", flush=True)
            open_entry()
            return
        time.sleep(0.5)
    print("MedDRA Browser 启动超时。请检查终端窗口中的错误信息。", file=sys.stderr, flush=True)


def main() -> int:
    if is_ready():
        print(f"MedDRA Browser 已在运行：{BASE_URL}", flush=True)
        open_entry()
        return 0

    sys.path.insert(0, str(ROOT / "backend"))
    os.environ.setdefault("PYTHONPATH", str(ROOT / "backend"))

    try:
        import uvicorn
    except ImportError as exc:
        print("未找到后端依赖 uvicorn。请重新运行第一步入口，或检查依赖安装是否失败。", file=sys.stderr)
        raise SystemExit(1) from exc

    threading.Thread(target=wait_until_ready_and_open, daemon=True).start()
    print("正在启动 MedDRA Browser 本地服务。使用时请保持这个终端窗口打开；不用时可关闭窗口停止服务。", flush=True)
    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
