"""Regression tests for client-side CSV export encoding.

Excel on Chinese Windows decodes CSV using the system codepage (GBK) unless the
file begins with a UTF-8 BOM, which garbles every Chinese MedDRA term. The
browser-side exports build their own Blob, so the BOM must be added there too --
the backend fix for /api/export/csv does not cover them.

JSON exports must stay BOM-free, because JSON.parse rejects a leading BOM.
"""

from __future__ import annotations

import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
APP_TSX = REPO_ROOT / "frontend" / "src" / "App.tsx"
# The TypeScript source spells the BOM as an escape sequence; the compiler turns
# it into U+FEFF. Matching the escape keeps the assertion readable and avoids a
# stray invisible BOM character inside this test file.
BOM_ESCAPE = "\\ufeff"


class FrontendCsvExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = APP_TSX.read_text(encoding="utf-8")

    def test_download_helper_prepends_utf8_bom_for_csv_only(self) -> None:
        self.assertIn("downloadText", self.source)
        start = self.source.index("function downloadText(")
        body = self.source[start : self.source.index("\n}", start)]

        self.assertIn(BOM_ESCAPE, body, "downloadText() does not add a UTF-8 BOM")
        # A doubled backslash would emit the literal text \ufeff into the CSV
        # instead of a byte-order mark, corrupting the first column header.
        self.assertNotIn("\\\\\\ufeff", body, "BOM escape must not be double-escaped")

        # The BOM must be conditional on the CSV mime type so JSON stays parseable.
        self.assertIn("text/csv", body)

    def test_csv_callers_use_the_csv_mime_type(self) -> None:
        # The BOM is keyed off the mime type, so every CSV download must declare it.
        for marker in (
            'rowsToCsv(flattenedSearchRows), "text/csv',
            'rowsToCsv(smqDetail.content), "text/csv',
            'rowsToCsv(bin), "text/csv',
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.source)

    def test_json_export_does_not_request_csv_mime(self) -> None:
        start = self.source.index("meddra_research_bin.json")
        line_end = self.source.index("\n", start)
        self.assertIn("application/json", self.source[start:line_end])
        self.assertNotIn("text/csv", self.source[start:line_end])


if __name__ == "__main__":
    unittest.main()
