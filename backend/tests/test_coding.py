from __future__ import annotations

import base64
import io
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from openpyxl import Workbook

from app.coding import (
    build_export_bundle,
    build_export_rows,
    code_to_csv,
    content_disposition_attachment,
    csv_safe_cell,
    parse_data_listing_csv,
    parse_data_listing_excel,
    safe_download_filename,
    validate_decision_against_store,
)
from app.meddra_data import clinical_zh_expansions


class ClinicalAliasTests(unittest.TestCase):
    def test_allergic_conjunctivitis_maps_to_meddra_wording(self) -> None:
        expansions = clinical_zh_expansions("过敏性结膜炎")
        self.assertTrue(any("变应性结膜炎" in rewritten for rewritten, _ in expansions))

    def test_no_false_rewrite_without_alias_fragment(self) -> None:
        self.assertEqual(clinical_zh_expansions("高血压"), [])


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

    def test_export_requires_human_confirmation_and_strips_suggestion_codes(self) -> None:
        unique_terms = [
            {
                "term": "头痛",
                "coding_type": "AE",
                "count": 1,
                "occurrences": [{"受试者编号": "001"}],
                "suggestion": {
                    "best": {"level": "LLT", "code": "10019211", "zh_name": "头痛", "en_name": "Headache", "match_type": "exact", "score": 100},
                },
            }
        ]
        pending = build_export_bundle(unique_terms, {})
        self.assertEqual(pending["coded_rows"], [])
        self.assertEqual(pending["exception_rows"][0]["编码状态"], "pending")
        self.assertEqual(pending["exception_rows"][0]["LLT代码"], "")

        rejected = build_export_bundle(unique_terms, {"AE|头痛": {"status": "rejected", "llt_code": "10019211"}})
        self.assertEqual(rejected["coded_rows"], [])
        self.assertEqual(rejected["exception_rows"][0]["LLT代码"], "")
        self.assertIn("拒绝", rejected["exception_rows"][0]["审阅异常原因"])

        accepted = build_export_bundle(
            unique_terms,
            {"AE|头痛": {"status": "accepted", "pt_code": "10019211", "llt_code": "10019211"}},
        )
        self.assertEqual(len(accepted["coded_rows"]), 1)
        self.assertEqual(accepted["exception_rows"], [])

    def test_csv_formula_cells_are_neutralized(self) -> None:
        self.assertEqual(csv_safe_cell("=cmd|'/c calc'!A0"), "'=cmd|'/c calc'!A0")
        text = code_to_csv([{"原文术语": "=1+2", "编码状态": "accepted", "PT代码": "+1234"}])
        self.assertIn("'=1+2", text)
        self.assertIn("'+1234", text)

    def test_content_disposition_keeps_ascii_filename_and_utf8_star(self) -> None:
        header = content_disposition_attachment("meddra_coded_粘贴列表-1词.csv")
        self.assertIn('filename="meddra_coded_', header)
        self.assertNotIn("粘贴", header.split("filename*=", 1)[0])
        self.assertIn("filename*=UTF-8''", header)
        self.assertIn("%", header)

    def test_excel_empty_rows_preserve_source_line_numbers(self) -> None:
        wb = Workbook()
        ws = wb.active
        assert ws is not None
        ws.title = "AE"
        ws.append(["项目编号", "不良事件名称(AETERM)"])
        ws.append(["P1", "头痛"])
        ws.append([None, None])
        ws.append(["P1", "皮疹"])
        buffer = io.BytesIO()
        wb.save(buffer)
        parsed = parse_data_listing_excel(buffer.getvalue(), "ae.xlsx")
        rows = {item["term"]: item["occurrences"][0]["excel_row"] for item in parsed["unique_terms"]}
        self.assertEqual(rows["头痛"], 2)
        self.assertEqual(rows["皮疹"], 4)

    def test_gb18030_csv_imports_without_mojibake(self) -> None:
        content = "不良事件名称(AETERM)\n头痛\n".encode("gb18030")
        parsed = parse_data_listing_csv(content, "ae.csv")
        self.assertEqual(parsed["unique_terms"][0]["term"], "头痛")

    def test_duplicate_headers_are_rejected(self) -> None:
        content = "不良事件名称(AETERM),不良事件名称(AETERM)\n头痛,头晕\n".encode("utf-8")
        with self.assertRaisesRegex(ValueError, "重复表头"):
            parse_data_listing_csv(content, "ae.csv")

    def test_import_payload_shape(self) -> None:
        # Ensure the shape used by the HTTP layer is stable.
        content = "表单编号,受试者编号,不良事件名称(AETERM)\nAE,001,发热\n".encode("utf-8")
        parsed = parse_data_listing_csv(content, "x.csv")
        self.assertIn("coding_targets", parsed)
        self.assertIn("unique_terms", parsed)
        self.assertIn("stats", parsed)

    def test_validate_decision_rejects_mismatched_pt_llt(self) -> None:
        class FakeStore:
            def term_by_code(self, level: str, code: str):
                if level == "LLT" and code == "10019211":
                    return {"code": "10019211", "parent_code": "10019211", "zh_name": "头痛", "en_name": "Headache", "is_current": "Y"}
                if level == "LLT" and code == "10000001":
                    return {"code": "10000001", "parent_code": "10019211", "zh_name": "旧词", "en_name": "Obsolete", "is_current": "N"}
                if level == "PT" and code == "10019211":
                    return {"code": "10019211", "zh_name": "头痛", "en_name": "Headache"}
                if level == "PT" and code == "99999999":
                    return {"code": "99999999", "zh_name": "其他", "en_name": "Other"}
                return None

        bad = validate_decision_against_store(
            FakeStore(),
            {"status": "accepted", "llt_code": "10019211", "pt_code": "99999999"},
        )
        self.assertFalse(bad["ok"])
        self.assertIn("父级 PT", bad["reason"])
        good = validate_decision_against_store(
            FakeStore(),
            {"status": "accepted", "llt_code": "10019211", "pt_code": "10019211"},
        )
        self.assertTrue(good["ok"])
        self.assertEqual(good["codes"]["pt_code"], "10019211")

        pt_only = validate_decision_against_store(
            FakeStore(),
            {"status": "accepted", "pt_code": "10019211"},
        )
        self.assertFalse(pt_only["ok"])
        self.assertIn("不允许仅 PT", pt_only["reason"])

        unknown = validate_decision_against_store(
            FakeStore(),
            {"status": "accepted", "llt_code": "00000000"},
        )
        self.assertFalse(unknown["ok"])
        self.assertIn("未知", unknown["reason"])

        obsolete = validate_decision_against_store(
            FakeStore(),
            {"status": "accepted", "llt_code": "10000001", "pt_code": "10019211"},
        )
        self.assertFalse(obsolete["ok"])
        self.assertIn("非当前", obsolete["reason"])

    def test_export_bundle_rejects_pt_only_and_noncurrent_when_store_bound(self) -> None:
        class FakeStore:
            def term_by_code(self, level: str, code: str):
                if level == "LLT" and code == "10019211":
                    return {"code": "10019211", "parent_code": "10019211", "zh_name": "头痛", "en_name": "Headache", "is_current": "Y"}
                if level == "LLT" and code == "10000001":
                    return {"code": "10000001", "parent_code": "10019211", "zh_name": "旧词", "en_name": "Obsolete", "is_current": "N"}
                if level == "PT" and code == "10019211":
                    return {"code": "10019211", "zh_name": "头痛", "en_name": "Headache"}
                return None

        unique_terms = [
            {"term": "头痛", "coding_type": "AE", "count": 1, "occurrences": [{"受试者编号": "001"}]},
            {"term": "旧词", "coding_type": "AE", "count": 1, "occurrences": [{"受试者编号": "002"}]},
            {"term": "仅PT", "coding_type": "AE", "count": 1, "occurrences": [{"受试者编号": "003"}]},
        ]
        decisions = {
            "AE|头痛": {"status": "accepted", "llt_code": "10019211", "pt_code": "10019211"},
            "AE|旧词": {"status": "accepted", "llt_code": "10000001", "pt_code": "10019211"},
            "AE|仅PT": {"status": "accepted", "pt_code": "10019211"},
        }
        bundle = build_export_bundle(
            unique_terms,
            decisions,
            dictionary_version="29.0",
            store=FakeStore(),
            source_signature="sig",
        )
        self.assertEqual(len(bundle["coded_rows"]), 1)
        self.assertEqual(bundle["coded_rows"][0]["原文术语"], "头痛")
        self.assertEqual(bundle["coded_rows"][0]["索引签名"], "sig")
        reasons = {row["原文术语"]: row["审阅异常原因"] for row in bundle["exception_rows"]}
        self.assertIn("非当前", reasons["旧词"])
        self.assertIn("仅 PT", reasons["仅PT"])


if __name__ == "__main__":
    unittest.main()
