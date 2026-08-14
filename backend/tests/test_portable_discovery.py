from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.meddra_data import REQUIRED_ASC_FILES, discover_releases, iter_dictionary_dirs
from workspace_paths import workspace_dictionary_root


ROOT = Path(__file__).resolve().parents[2]
PORTABLE_SERVER = ROOT / "scripts" / "run_portable_server.py"
PORTABLE_HTML = ROOT / "portable-index.html"


def load_portable_server():
    spec = importlib.util.spec_from_file_location("run_portable_server", PORTABLE_SERVER)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def write_fake_dictionary(base: Path) -> Path:
    ascii_dir = base / "MedDRA_29_0_English" / "MedAscii"
    ascii_dir.mkdir(parents=True)
    for name in REQUIRED_ASC_FILES:
        (ascii_dir / name).write_text("10000001$Term$\n", encoding="utf-8")
    return ascii_dir


class PortableDiscoveryTests(unittest.TestCase):
    def test_default_html_scan_window_misses_dedicated_8861_port(self) -> None:
        html = PORTABLE_HTML.read_text(encoding="utf-8")
        self.assertIn("8765", html)
        self.assertIn("index < 20", html)
        default_ports = list(range(8765, 8785))
        self.assertNotIn(8861, default_ports)
        self.assertIn("portable-active-port.js", html)
        self.assertIn("__MEDDRA_PORTABLE_RUNTIME", html)

    def test_file_entry_prefers_launcher_sidecar_without_localhost_fetch(self) -> None:
        html = PORTABLE_HTML.read_text(encoding="utf-8")
        self.assertIn('script.src = "portable-active-port.js', html)
        self.assertIn("window.location.href = sidecar.url", html)
        self.assertIn("file://", html)

    def test_sidecar_writer_records_selected_port(self) -> None:
        module = load_portable_server()
        with TemporaryDirectory() as tmp:
            fake_root = Path(tmp)
            with patch.object(module, "ROOT", fake_root), patch.object(module, "HOST", "127.0.0.1"):
                module.write_active_port_sidecar(8861)
            sidecar = (fake_root / "portable-active-port.js").read_text(encoding="utf-8")
            self.assertIn("8861", sidecar)
            self.assertIn("http://127.0.0.1:8861/", sidecar)
            self.assertIn("window.__MEDDRA_PORTABLE_RUNTIME", sidecar)
            note = (fake_root / "当前服务地址.txt").read_text(encoding="utf-8")
            self.assertIn("http://127.0.0.1:8861/", note)

    def test_select_port_skips_non_portable_and_unknown_identities(self) -> None:
        module = load_portable_server()
        identities = {
            8765: {"distribution_mode": "free_mac", "app_store_mode": False},
            8766: {"distribution_mode": "unknown"},
            8767: None,
        }

        def fake_runtime(port=None):
            return identities.get(port if port is not None else 8765)

        with patch.object(module, "REQUESTED_PORT", 8765), patch.object(module, "runtime_info", side_effect=fake_runtime):
            self.assertEqual(module.select_port(), 8767)

        identities[8767] = {"distribution_mode": "portable", "app_store_mode": False}
        with patch.object(module, "REQUESTED_PORT", 8765), patch.object(module, "runtime_info", side_effect=fake_runtime):
            self.assertEqual(module.select_port(), 8767)

    def test_runtime_info_allows_private_network_preflight(self) -> None:
        with patch.dict(
            os.environ,
            {"MEDDRA_APP_STORE_MODE": "0", "MEDDRA_DISTRIBUTION_MODE": "portable"},
            clear=False,
        ):
            client = TestClient(app)
            response = client.options(
                "/api/runtime-info",
                headers={
                    "Origin": "null",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Private-Network": "true",
                },
            )
        self.assertEqual(response.headers.get("access-control-allow-private-network"), "true")
        self.assertIn(response.headers.get("access-control-allow-origin"), {"null", "*"})

    def test_iter_dictionary_dirs_skips_node_modules_and_worktrees(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fake_dictionary(root)
            junk = root / "qa-worktrees" / "grok" / "frontend" / "node_modules" / "fake-package"
            junk.mkdir(parents=True)
            (junk / "soc.asc").write_text("should-not-be-used\n", encoding="utf-8")
            for index in range(50):
                nested = junk / f"deep-{index}"
                nested.mkdir()
                (nested / "noise.txt").write_text("x" * 100, encoding="utf-8")
            found = list(iter_dictionary_dirs(root))
            self.assertTrue(any(path.name == "MedAscii" for path in found))
            self.assertFalse(any("node_modules" in path.parts for path in found))
            self.assertFalse(any("qa-worktrees" in path.parts for path in found))
            releases = discover_releases(root)
            self.assertEqual([row.version for row in releases], ["29.0"])

    def test_workspace_parent_discovery_stays_bounded(self) -> None:
        root = workspace_dictionary_root()
        found = list(iter_dictionary_dirs(root))
        self.assertTrue(any(path.name in {"ascii-290", "MedAscii"} or "ascii" in path.name.lower() for path in found))
        self.assertFalse(any("node_modules" in path.parts or "qa-worktrees" in path.parts for path in found))
        releases = {row.version for row in discover_releases(root)}
        self.assertIn("29.0", releases)

    def test_zip_builder_sets_utf8_flag_for_cjk_names(self) -> None:
        script = (ROOT / "scripts" / "build_portable_package.sh").read_text(encoding="utf-8")
        self.assertIn("flag_bits |= 0x800", script)
        self.assertIn("strict_timestamps=False", script)


if __name__ == "__main__":
    unittest.main()
