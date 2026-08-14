from __future__ import annotations

import json
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
REQUESTED_PORT = int(os.environ.get("MEDDRA_BROWSER_PORT", "8765"))
PORT = REQUESTED_PORT
BASE_URL = ""
READY_URL = ""
HTML_ENTRY = ROOT / "第二步：双击我开始MedDRA浏览.html"
FALLBACK_HTML_ENTRY = ROOT / "index.html"
PORT_SCAN_LIMIT = 20


def update_urls(port: int) -> None:
    global PORT, BASE_URL, READY_URL
    PORT = port
    BASE_URL = f"http://{HOST}:{PORT}/"
    READY_URL = f"{BASE_URL}api/runtime-info"


def runtime_info(port: int | None = None) -> dict[str, object] | None:
    target_port = port if port is not None else PORT
    url = f"http://{HOST}:{target_port}/api/runtime-info"
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else {"distribution_mode": "unknown"}
    except urllib.error.HTTPError:
        # A live server without our identity endpoint still owns this port.
        return {"distribution_mode": "unknown"}
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return None


def is_portable_server(info: dict[str, object] | None) -> bool:
    return bool(
        info
        and info.get("distribution_mode") == "portable"
        and info.get("app_store_mode") is False
    )


def select_port() -> int:
    for candidate in range(REQUESTED_PORT, REQUESTED_PORT + PORT_SCAN_LIMIT):
        info = runtime_info(candidate)
        if info is None:
            if candidate != REQUESTED_PORT:
                print(f"端口 {REQUESTED_PORT} 已被其他服务占用，便携版改用端口 {candidate}。", flush=True)
            return candidate
        if is_portable_server(info):
            return candidate
    raise RuntimeError(
        f"端口 {REQUESTED_PORT}-{REQUESTED_PORT + PORT_SCAN_LIMIT - 1} 均已被其他服务占用，"
        "请关闭其他 MedDRA 实例后重试。"
    )


def is_ready() -> bool:
    return is_portable_server(runtime_info())


def open_entry() -> None:
    if os.environ.get("MEDDRA_BROWSER_OPEN", "1") == "0":
        return
    # Open the served page instead of the file:// helper whenever the bundle
    # contains the built frontend. This avoids browser file-origin restrictions
    # and makes the normal first-step double-click flow independent of CORS.
    if (ROOT / "frontend" / "dist" / "index.html").exists():
        webbrowser.open(BASE_URL)
        return
    entry = HTML_ENTRY if HTML_ENTRY.exists() else FALLBACK_HTML_ENTRY
    if entry.exists():
        webbrowser.open(f"{entry.resolve().as_uri()}?port={PORT}")
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
    # Do not inherit the environment of an App Store candidate or another
    # GUI-launched process when the portable bundle is started from Finder.
    os.environ["MEDDRA_APP_STORE_MODE"] = "0"
    os.environ["MEDDRA_DISTRIBUTION_MODE"] = "portable"
    selected_port = select_port()
    update_urls(selected_port)
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
