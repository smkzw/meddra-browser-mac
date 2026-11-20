"""Exercise the launcher and sidecar with a real server and isolated data."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
PREFIX = "window.__MEDDRA_PORTABLE_RUNTIME = "


class DistributionLauncherTests(unittest.TestCase):
    def test_portable_session_reserves_port_reopens_and_exits(self) -> None:
        with TemporaryDirectory(prefix="meddra-portable-") as directory:
            root = Path(directory)
            (root / "frontend/dist").mkdir(parents=True)
            (root / "frontend/dist/index.html").write_text("portable fixture", encoding="utf-8")
            (root / "scripts").mkdir()
            runner = root / "scripts/run_portable_server.py"
            shutil.copy2(ROOT / "scripts/run_portable_server.py", runner)
            shutil.copytree(ROOT / "backend/app", root / "backend/app")
            command = [sys.executable, "-I", "-B", "-X", "utf8", str(runner)]
            sidecar = root / "portable-active-port.js"

            with socket.socket() as occupied:
                occupied.bind(("127.0.0.1", 0))
                occupied.listen()
                port = occupied.getsockname()[1]
                env = dict(os.environ, MEDDRA_BROWSER_PORT=str(port), MEDDRA_BROWSER_OPEN="0",
                           MEDDRA_SOURCE_ROOT="", MEDDRA_BROWSER_STATE_DIR=str(root / "state"))
                process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 15
                    while not sidecar.exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.05)
                    if not sidecar.exists():
                        if process.poll() is not None:
                            self.fail(process.communicate()[0].decode("utf-8"))
                        self.fail("Portable session did not become ready.")
                    text = sidecar.read_text(encoding="utf-8").strip()
                    self.assertTrue(text.startswith(PREFIX))
                    info = json.loads(text[len(PREFIX):-1])
                    self.assertNotEqual(port, info["port"])
                    url = info["url"]
                    with urlopen(url + "api/runtime-info", timeout=3) as response:
                        runtime = json.load(response)
                    self.assertEqual(runtime["instance_id"], info["instance_id"])
                    self.assertEqual(runtime["distribution_mode"], "portable")
                    self.assertTrue(runtime["shutdown_available"])

                    reused = subprocess.run(command, env=env, capture_output=True, timeout=10)
                    self.assertEqual(reused.returncode, 0, reused.stderr.decode("utf-8"))
                    self.assertIn(url.encode(), reused.stdout)
                    self.assertEqual(sidecar.read_text(encoding="utf-8").strip(), text)

                    request = Request(url + "api/runtime/shutdown", data=b"{}", method="POST",
                                      headers={"Content-Type": "application/json", "Origin": url.rstrip("/")})
                    with urlopen(request, timeout=3) as response:
                        self.assertEqual(json.load(response)["status"], "stopping")
                    self.assertEqual(process.wait(timeout=10), 0)
                    self.assertFalse(sidecar.exists())
                    self.assertFalse((root / "当前服务地址.txt").exists())
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main()
