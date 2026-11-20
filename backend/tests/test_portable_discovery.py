from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


from app.meddra_data import REQUIRED_ASC_FILES, discover_releases, iter_dictionary_dirs
from workspace_paths import workspace_dictionary_root


def write_fake_dictionary(base: Path) -> Path:
    ascii_dir = base / "MedDRA_29_0_English" / "MedAscii"
    ascii_dir.mkdir(parents=True)
    for name in REQUIRED_ASC_FILES:
        (ascii_dir / name).write_text("10000001$Term$\n", encoding="utf-8")
    return ascii_dir


class PortableDiscoveryTests(unittest.TestCase):
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
        root = Path(os.environ["MEDDRA_SOURCE_ROOT"]) if os.environ.get("MEDDRA_SOURCE_ROOT") else workspace_dictionary_root()
        found = list(iter_dictionary_dirs(root))
        self.assertTrue(any(path.name in {"ascii-290", "MedAscii"} or "ascii" in path.name.lower() for path in found))
        self.assertFalse(any("node_modules" in path.parts or "qa-worktrees" in path.parts for path in found))
        releases = {row.version for row in discover_releases(root)}
        self.assertIn("29.0", releases)

if __name__ == "__main__":
    unittest.main()
