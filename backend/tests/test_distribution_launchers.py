from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class DistributionLauncherTests(unittest.TestCase):
    def test_macos_launcher_does_not_assume_port_8765_is_free(self) -> None:
        source = (ROOT / "scripts" / "build_macos_app.sh").read_text(encoding="utf-8")

        self.assertIn('REQUESTED_PORT="${MEDDRA_BROWSER_PORT:-8765}"', source)
        self.assertIn('PORT_SCAN_LIMIT="${MEDDRA_BROWSER_PORT_SCAN_LIMIT:-20}"', source)
        self.assertIn("runtime_http_code()", source)
        self.assertIn("matching_runtime()", source)
        self.assertIn("REUSE_EXISTING_SERVER=0", source)
        self.assertIn("/api/runtime-info", source)
        self.assertIn("改用 ${PORT}", source)

    def test_windows_launcher_keeps_offline_first_run_self_contained(self) -> None:
        source = (ROOT / "start_windows.bat").read_text(encoding="utf-8")

        self.assertIn("chcp 65001", source)
        self.assertIn('python-installer.exe', source)
        self.assertIn('dir /b /a-d "wheelhouse\\*.whl"', source)
        self.assertIn("--no-index --find-links", source)
        self.assertIn("scripts\\run_portable_server.py", source)
        self.assertIn('set "MEDDRA_APP_STORE_MODE=0"', source)

    def test_portable_package_copies_the_current_windows_launcher(self) -> None:
        source = (ROOT / "scripts" / "build_portable_package.sh").read_text(encoding="utf-8")

        self.assertIn('cp start_windows.bat "${PACKAGE_ROOT}/start_windows.bat"', source)
        self.assertIn('cp start_windows.bat "${PACKAGE_ROOT}/【Windows】第一步：请双击我运行.bat"', source)
        self.assertIn('cp "${WINDOWS_INSTALLER_PATH}" "${PACKAGE_ROOT}/tools/python/windows/python-installer.exe"', source)


if __name__ == "__main__":
    unittest.main()
