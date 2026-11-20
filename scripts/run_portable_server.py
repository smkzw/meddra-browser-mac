"""Own the packaged localhost service for one desktop or portable session."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser


ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
PORT_FILE = ROOT / "portable-active-port.js"
ADDRESS_FILE = ROOT / "当前服务地址.txt"
PORT_PREFIX = "window.__MEDDRA_PORTABLE_RUNTIME = "


@contextmanager
def instance_lock(path: Path):
    """The OS releases this lock even when a launcher is closed abruptly."""
    with path.open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt

                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        except OSError as exc:
            if os.name == "nt" and exc.errno == 13:
                yield False
                return
            raise
        yield True


def bind_socket(preferred: int) -> socket.socket:
    """Reserve the loopback port before announcing it to the UI."""
    listener = socket.socket()
    try:
        if os.name == "nt":
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((HOST, preferred))
        except OSError:
            if not preferred:
                raise
            listener.bind((HOST, 0))
    except BaseException:
        listener.close()
        raise
    return listener


def write_atomic(path: Path, text: str) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(text, encoding="utf-8")
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def open_browser(url: str) -> None:
    if os.environ.get("MEDDRA_BROWSER_OPEN", "1") != "0":
        if not webbrowser.open(url):
            print(f"浏览器没有自动打开。请在地址栏输入 {url}", flush=True)


def portable_url() -> str | None:
    """Only reopen the active service named by this copy of the portable app."""
    try:
        text = PORT_FILE.read_text(encoding="utf-8").strip()
        if not text.startswith(PORT_PREFIX) or not text.endswith(";"):
            return None
        hint = json.loads(text[len(PORT_PREFIX):-1])
        port = int(hint["port"])
        if not 1 <= port <= 65535:
            return None
        url = f"http://{HOST}:{port}/"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"{url}api/runtime-info", timeout=0.5) as response:
            current = json.load(response)
        if current.get("distribution_mode") == "portable" and current.get("instance_id") == hint["instance_id"]:
            return url
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return None


def reopen_portable() -> int:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        url = portable_url()
        if url:
            print(f"便携版已在运行：{url}", flush=True)
            open_browser(url)
            return 0
        time.sleep(0.25)
    raise RuntimeError("同一个便携文件夹已有一个启动窗口。请查看原窗口，退出后再启动。")


async def serve(listener: socket.socket, instance_id: str, mode: str, ready_path: Path | None) -> None:
    import uvicorn
    from app.main import app

    port = listener.getsockname()[1]
    url = f"http://{HOST}:{port}/"
    server = uvicorn.Server(uvicorn.Config(
        app, host=HOST, port=port, access_log=False, proxy_headers=False, timeout_graceful_shutdown=3,
    ))
    loop = asyncio.get_running_loop()

    def request_shutdown() -> None:
        server.should_exit = True

    # Let the response leave before shutting down the loop.
    if mode == "portable":
        app.state.request_shutdown = lambda: loop.call_soon_threadsafe(loop.call_later, 0.2, request_shutdown)

    def on_signal(_number, _frame) -> None:
        request_shutdown()

    for name in ("SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"):
        number = getattr(signal, name, None)
        if number is not None:
            signal.signal(number, on_signal)

    if ready_path is not None:
        # The parent never writes. EOF also arrives if the native app crashes.
        def watch_parent() -> None:
            os.read(0, 1)
            if not loop.is_closed():
                loop.call_soon_threadsafe(request_shutdown)

        threading.Thread(target=watch_parent, daemon=True, name="native-parent").start()

    task = asyncio.create_task(server.serve(sockets=[listener]))
    while not server.started and not task.done():
        await asyncio.sleep(0.04)
    if not server.started:
        await task
        raise RuntimeError("本地服务未能完成启动。")

    runtime = {"port": port, "url": url, "instance_id": instance_id, "distribution_mode": mode}
    if ready_path is not None:
        write_atomic(ready_path, json.dumps(runtime))
        print(f"工作台已就绪：{url}", flush=True)
    elif mode == "portable":
        write_atomic(PORT_FILE, PORT_PREFIX + json.dumps(runtime, separators=(",", ":")) + ";\n")
        write_atomic(ADDRESS_FILE, f"{url}\n")
        print(f"便携版已启动：{url}\n用完可在工作台点击「退出便携版」，或在此按 Ctrl+C。", flush=True)
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()
    else:
        print(f"开发服务已启动：{url}\n按 Ctrl+C 停止。", flush=True)
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()
    await task


def main() -> int:
    args = sys.argv[1:]
    ready_path = Path(args[1]) if len(args) == 2 and args[0] == "--native" else None
    if ready_path:
        app_store = os.environ.get("MEDDRA_APP_STORE_MODE") == "1"
        mode = "app_store_candidate" if app_store else "free_mac"
    else:
        app_store = False
        mode = "local" if args == ["--dev"] else "portable"
    os.environ["MEDDRA_APP_STORE_MODE"] = "1" if app_store else "0"
    os.environ["MEDDRA_DISTRIBUTION_MODE"] = mode
    os.environ["MEDDRA_INSTANCE_ID"] = instance_id = uuid.uuid4().hex
    os.environ.setdefault("MEDDRA_BROWSER_STATE_DIR", str(ROOT / "backend" / "data"))
    state = Path(os.environ["MEDDRA_BROWSER_STATE_DIR"])
    state.mkdir(parents=True, exist_ok=True)
    # Portable addresses belong to the package, even when QA overrides its data directory.
    lock = ROOT / ".meddra-portable.lock" if mode == "portable" else state / ".launch.lock"
    sys.path.insert(0, str(ROOT / "backend"))
    if not (ROOT / "frontend" / "dist" / "index.html").is_file():
        raise RuntimeError("缺少工作台文件。请完整解压发布包，或先构建前端。")
    with instance_lock(lock) as owned:
        if not owned:
            if mode == "portable":
                return reopen_portable()
            raise RuntimeError("当前数据目录已被另一工作台使用。请先退出原窗口。")
        if mode == "portable":
            PORT_FILE.unlink(missing_ok=True)
            ADDRESS_FILE.unlink(missing_ok=True)
        try:
            preferred = int(os.environ.get("MEDDRA_BROWSER_PORT", "8765"))
            with bind_socket(preferred) as listener:
                asyncio.run(serve(listener, instance_id, mode, ready_path))
        finally:
            if mode == "portable":
                PORT_FILE.unlink(missing_ok=True)
                ADDRESS_FILE.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ImportError, RuntimeError, OSError, ValueError, OverflowError) as exc:
        print(f"MedDRA Browser 启动失败：{exc}", file=sys.stderr, flush=True)
        print("请确认已完整解压到可写文件夹。如果文件缺失，请重新下载发布包。", file=sys.stderr)
        raise SystemExit(1) from exc
