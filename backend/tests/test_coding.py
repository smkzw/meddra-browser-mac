from __future__ import annotations

import base64
import io
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from openpyxl import Workbook

from app.coding import (
    build_export_rows,
    code_to_csv,
    parse_data_listing_csv,
    parse_data_listing_excel,
    safe_download_filename,
)


def _encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class CodingListingTests(unittest.TestCase):
    def test_safe_download_filename_strips_path_and_quotes(self) -> None:
        self.assertEqual(safe_download_filename("../../evil.csv"), "evil.csv")
        self.assertEqual(safe_download_filename('a"b.csv'), "ab.csv")
        self.assertEqual(safe_download_filename("listing.xlsx"), "listing.xlsx.csv")

    def test_parse_csv_detects_ae_term_column(self) -> None:
        content = (
            "项目编号,表单编号,受试者编号,不良事件名称(AETERM),严重程度(AESEV)\n"
            "P1,AE,001,头痛,轻度\n"
            "P1,AE,002,高血压,中度\n"
            "P1,AE,003,头痛,重度\n"
        ).encode("utf-8")
        parsed = parse_data_listing_csv(content, "AE.csv")
        self.assertGreaterEqual(parsed["stats"]["unique_term_count"], 2)
        terms = {item["term"]: item for item in parsed["unique_terms"]}
        self.assertIn("头痛", terms)
        self.assertEqual(terms["头痛"]["count"], 2)
        self.assertEqual(terms["头痛"]["coding_type"], "AE")

    def test_parse_excel_multi_sheet(self) -> None:
        wb = Workbook()
        ws_ae = wb.active
        assert ws_ae is not None
        ws_ae.title = "AE"
        ws_ae.append(["项目编号", "表单编号", "受试者编号", "不良事件名称(AETERM)", "严重程度(AESEV)"])
        ws_ae.append(["P1", "AE", "001", "头痛", "轻度"])
        ws_ae.append(["P1", "AE", "002", "皮疹", "中度"])
        ws_mh = wb.create_sheet("MH")
        ws_mh.append(["项目编号", "表单编号", "受试者编号", "疾病名称(MHTERM)"])
        ws_mh.append(["P1", "MH", "001", "高血压"])
        ws_mh.append(["P1", "MH", "001", "2型糖尿病"])
        buffer = io.BytesIO()
        wb.save(buffer)
        parsed = parse_data_listing_excel(buffer.getvalue(), "listing.xlsx")
        self.assertEqual(parsed["stats"]["target_count"], 2)
        coding_types = {item["coding_type"] for item in parsed["unique_terms"]}
        self.assertIn("AE", coding_types)
        self.assertIn("MH", coding_types)

    def test_build_export_rows_and_csv(self) -> None:
        unique_terms = [
            {
                "term": "头痛",
                "coding_type": "AE",
                "count": 1,
                "occurrences": [{"受试者编号": "001", "sheet": "AE", "column": "不良事件名称(AETERM)", "excel_row": 2}],
                "suggestion": {
                    "best": {"level": "LLT", "code": "10019211", "zh_name": "头痛", "en_name": "Headache", "match_type": "exact"},
                },
            }
        ]
        decisions = {
            "AE|头痛": {"status": "accepted", "pt_code": "10019211", "pt_zh": "头痛", "llt_code": "10019211"}
        }
        rows = build_export_rows(unique_terms, decisions)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["PT代码"], "10019211")
        self.assertEqual(rows[0]["受试者编号"], "001")
        csv_text = code_to_csv(rows)
        self.assertIn("头痛", csv_text)
        self.assertIn("PT代码", csv_text)

    def test_import_payload_shape(self) -> None:
        # Ensure the shape used by the HTTP layer is stable.
        content = "表单编号,受试者编号,不良事件名称(AETERM)\nAE,001,发热\n".encode("utf-8")
        parsed = parse_data_listing_csv(content, "x.csv")
        self.assertIn("coding_targets", parsed)
        self.assertIn("unique_terms", parsed)
        self.assertIn("stats", parsed)


if __name__ == "__main__":
    unittest.main()
