"""Regression tests for the two-step portable entry page (portable-index.html).

The step-2 page is a plain ``file://`` document, so it is not covered by the
FastAPI test client. These tests pin the port-discovery contract that decides
whether a user who double-clicks step 1 then step 2 actually reaches the app:

* the documented default range (8765..8784) must ALWAYS be probed, and
* a ``?port=`` hint may only ADD candidates, never replace the default range.

A stale hint replacing the default range is what strands the page on
"还没有检测到便携版服务" even though the launcher is serving normally.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRY_PAGE = REPO_ROOT / "portable-index.html"
DEFAULT_PORT = 8765
SCAN_WIDTH = 20
DEFAULT_RANGE = list(range(DEFAULT_PORT, DEFAULT_PORT + SCAN_WIDTH))


def extract_function(source: str, name: str) -> str:
    """Return the source text of a top-level ``function name(...) {...}`` block."""
    start = source.index(f"function {name}(")
    depth = 0
    for index in range(start, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    raise AssertionError(f"unbalanced braces while extracting {name}()")


class PortableEntryPageSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = ENTRY_PAGE.read_text(encoding="utf-8")

    def test_entry_page_exists_and_declares_default_port_range(self) -> None:
        self.assertTrue(ENTRY_PAGE.is_file(), f"missing entry page: {ENTRY_PAGE}")
        self.assertIn(f"DEFAULT_PORT = {DEFAULT_PORT}", self.source)
        self.assertIn(f"SCAN_WIDTH = {SCAN_WIDTH}", self.source)

    def test_candidate_ports_is_derived_from_default_port_not_from_the_hint_alone(self) -> None:
        candidate_source = extract_function(self.source, "candidatePorts")
        # The default range must be seeded from DEFAULT_PORT unconditionally,
        # i.e. outside of any `if (hint ...)` branch.
        self.assertIn("DEFAULT_PORT + index", candidate_source)
        hint_branch = re.search(r"if \(hint !== null\) \{(.*?)\n        \}", candidate_source, re.S)
        self.assertIsNotNone(hint_branch, "expected a hint-only branch in candidatePorts()")
        self.assertNotIn("DEFAULT_PORT", hint_branch.group(1))

    def test_probe_loop_uses_candidate_ports(self) -> None:
        check_source = extract_function(self.source, "checkServer")
        self.assertIn("candidatePorts(", check_source)

    def test_missing_service_has_bounded_retry_and_manual_recovery(self) -> None:
        self.assertIn("MAX_AUTOMATIC_ATTEMPTS = 30", self.source)
        self.assertIn('id="retry"', self.source)
        self.assertIn("点击“重新检测”", self.source)


@unittest.skipIf(shutil.which("node") is None, "node is unavailable; JS behaviour test skipped")
class PortableEntryPageBehaviourTests(unittest.TestCase):
    """Execute the real JS from the shipped page under Node."""

    @classmethod
    def setUpClass(cls) -> None:
        source = ENTRY_PAGE.read_text(encoding="utf-8")
        cls.js_prelude = "\n".join(
            [
                "const DEFAULT_PORT = %d;" % DEFAULT_PORT,
                "const SCAN_WIDTH = %d;" % SCAN_WIDTH,
                extract_function(source, "hintedPort"),
                extract_function(source, "candidatePorts"),
            ]
        )

    def candidates_for(self, search: str) -> list[int]:
        script = "\n".join(
            [
                f"global.window = {{ location: {{ search: {json.dumps(search)} }} }};",
                "const URLSearchParams = global.URLSearchParams;",
                self.js_prelude,
                "process.stdout.write(JSON.stringify(candidatePorts()));",
            ]
        )
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_no_hint_scans_the_documented_default_range(self) -> None:
        self.assertEqual(self.candidates_for(""), DEFAULT_RANGE)

    def test_fallback_port_inside_default_range_is_reachable_without_a_hint(self) -> None:
        # The launcher walks upward from 8765 when the port is taken.
        self.assertIn(8766, self.candidates_for(""))

    def test_hint_is_probed_first_but_default_range_is_still_scanned(self) -> None:
        candidates = self.candidates_for("?port=8862")
        self.assertEqual(candidates[0], 8862)
        self.assertEqual(candidates[:SCAN_WIDTH], list(range(8862, 8862 + SCAN_WIDTH)))
        for port in DEFAULT_RANGE:
            self.assertIn(port, candidates)

    def test_stale_hint_does_not_strand_the_page(self) -> None:
        # A leftover ?port=9999 from an earlier run must not hide a service on 8766.
        candidates = self.candidates_for("?port=9999")
        self.assertIn(9999, candidates)
        self.assertIn(8766, candidates)
        for port in DEFAULT_RANGE:
            self.assertIn(port, candidates)

    def test_invalid_or_out_of_range_hints_fall_back_to_the_default_range(self) -> None:
        for search in ("?port=abc", "?port=0", "?port=80", "?port=99999", "?port=-1", "?port="):
            with self.subTest(search=search):
                self.assertEqual(self.candidates_for(search), DEFAULT_RANGE)

    def test_candidates_are_unique(self) -> None:
        # An overlapping hint must not produce duplicate probes.
        candidates = self.candidates_for("?port=8770")
        self.assertEqual(len(candidates), len(set(candidates)))
        for port in DEFAULT_RANGE:
            self.assertIn(port, candidates)


if __name__ == "__main__":
    unittest.main()
