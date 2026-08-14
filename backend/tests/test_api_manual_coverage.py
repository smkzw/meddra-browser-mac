from __future__ import annotations

import os
from pathlib import Path
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from workspace_paths import workspace_dictionary_root

if not os.environ.get("MEDDRA_SOURCE_ROOT"):
    os.environ["MEDDRA_SOURCE_ROOT"] = str(workspace_dictionary_root())

from app.main import INDEX_JOBS, INDEX_LOCK, app, index_job_key, index_status_for_config
from app.meddra_data import MeddraIndexer, default_source_config


class ApiManualCoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.version = "29.0"
        MeddraIndexer(default_source_config(cls.version)).ensure_index(force=True)
        cls.client = TestClient(app)

    def test_status_and_version_discovery(self) -> None:
        index_status = self.client.get("/api/index-status", params={"version": self.version}).json()
        self.assertEqual(index_status["state"], "ready")
        self.assertEqual(index_status["percent"], 100)
        self.assertIn("processed_rows", index_status)
        self.assertIn("total_rows", index_status)

        status = self.client.get("/api/status", params={"version": self.version}).json()
        self.assertEqual(status["version"], self.version)
        self.assertNotIn("db_path", status)
        self.assertNotIn("source_directories", status)
        self.assertIn("available_versions", status)

        releases = self.client.get("/api/releases").json()["releases"]
        self.assertTrue(any(row["version"] == self.version and row["complete"] for row in releases))
        self.assertFalse(any("english_dir" in row or "chinese_dir" in row for row in releases))
        self.assertIn("PT", status["search_levels"])
        self.assertIn("SMQ", status["search_levels"])

    def test_runtime_info_distinguishes_portable_and_app_store_modes(self) -> None:
        with patch.dict(
            os.environ,
            {"MEDDRA_APP_STORE_MODE": "0", "MEDDRA_DISTRIBUTION_MODE": "portable"},
            clear=False,
        ):
            portable = self.client.get("/api/runtime-info").json()
        self.assertFalse(portable["app_store_mode"])
        self.assertEqual(portable["distribution_mode"], "portable")

        with patch.dict(os.environ, {"MEDDRA_APP_STORE_MODE": "1"}, clear=False):
            candidate = self.client.get("/api/runtime-info").json()
        self.assertTrue(candidate["app_store_mode"])
        self.assertEqual(candidate["distribution_mode"], "app_store_candidate")

    def test_runtime_info_supports_file_entry_jsonp_probe(self) -> None:
        with patch.dict(
            os.environ,
            {"MEDDRA_APP_STORE_MODE": "0", "MEDDRA_DISTRIBUTION_MODE": "portable"},
            clear=False,
        ):
            response = self.client.get("/api/runtime-info", params={"callback": "__meddraProbe1"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/javascript", response.headers["content-type"])
        self.assertTrue(response.text.startswith("__meddraProbe1("))
        self.assertIn('"distribution_mode":"portable"', response.text)

        invalid = self.client.get("/api/runtime-info", params={"callback": "alert(1)"})
        self.assertEqual(invalid.status_code, 400)

    def test_search_categories_code_and_soc_filter(self) -> None:
        exact = self.client.post(
            "/api/search",
            json={"version": self.version, "query": "Rhabdomyolysis", "mode": "en", "levels": ["PT"]},
        ).json()
        self.assertEqual(exact["groups"][0]["category"], "exact")
        self.assertEqual(exact["groups"][0]["results"][0]["code"], "10039020")

        fuzzy = self.client.post(
            "/api/search",
            json={
                "version": self.version,
                "query": "rhabdomyolisys",
                "mode": "en",
                "levels": ["PT"],
                "include_synonyms": False,
            },
        ).json()
        fuzzy_groups = [row for row in fuzzy["groups"] if row["category"] == "fuzzy"]
        self.assertTrue(fuzzy_groups)
        self.assertIn("近似文本候选", fuzzy_groups[0]["results"][0]["reason"])
        self.assertNotIn("模糊相似度", fuzzy_groups[0]["results"][0]["reason"])

        filtered = self.client.post(
            "/api/search",
            json={
                "version": self.version,
                "query": "横纹肌",
                "mode": "zh",
                "levels": ["PT"],
                "soc_codes": ["10028395"],
            },
        ).json()
        self.assertGreater(filtered["count"], 0)

        code = self.client.post(
            "/api/search",
            json={"version": self.version, "query": "10039020", "mode": "both"},
        ).json()
        self.assertTrue(any(group["category"] == "code" for group in code["groups"]))

        default_pt = self.client.post(
            "/api/search",
            json={"version": self.version, "query": "横纹肌", "mode": "zh", "include_synonyms": False},
        ).json()
        self.assertTrue(default_pt["groups"])
        self.assertTrue(all(row["level"] == "PT" for group in default_pt["groups"] for row in group["results"]))

        smq = self.client.post(
            "/api/search",
            json={"version": self.version, "query": "横纹肌", "mode": "zh", "levels": ["SMQ"]},
        ).json()
        smq_groups = [group for group in smq["groups"] if group["category"] == "smq"]
        self.assertTrue(smq_groups)
        self.assertTrue(any(row["level"] == "SMQ" for row in smq_groups[0]["results"]))

    def test_advanced_search_boolean_variants(self) -> None:
        for boolean in ["AND", "OR", "NOT"]:
            result = self.client.post(
                "/api/advanced-search",
                json={
                    "version": self.version,
                    "mode": "en",
                    "levels": ["PT"],
                    "boolean": boolean,
                    "conditions": [
                        {"value": "renal", "operator": "contains"},
                        {"value": "failure", "operator": "contains"},
                    ],
                },
            ).json()
            self.assertIn("results", result)

    def test_browse_details_analysis_and_copy_source_fields(self) -> None:
        tree = self.client.get("/api/tree/soc", params={"version": self.version, "mode": "zh"}).json()
        self.assertEqual(len(tree["nodes"]), 27)

        detail = self.client.get("/api/details/PT/10039020", params={"version": self.version}).json()
        self.assertTrue(detail["found"])
        self.assertEqual(detail["term"]["zh_name"], "横纹肌溶解")
        self.assertGreater(len(detail["hierarchies"]), 0)
        self.assertGreater(len(detail["smq_memberships"]), 0)
        self.assertIn("relationships", detail)
        self.assertGreater(len(detail["relationships"]["parents"]), 0)
        self.assertGreater(len(detail["relationships"]["children"]), 0)

        hierarchy = self.client.get("/api/analysis/hierarchy/PT/10039020", params={"version": self.version}).json()
        smq = self.client.get("/api/analysis/smq/PT/10039020", params={"version": self.version}).json()
        self.assertGreater(hierarchy["count"], 0)
        self.assertGreater(smq["count"], 0)

    def test_smq_search_details_and_export_support(self) -> None:
        smq_search = self.client.get(
            "/api/smq/search", params={"version": self.version, "mode": "zh", "query": "横纹肌"}
        ).json()
        self.assertGreater(smq_search["count"], 0)
        self.assertEqual(smq_search["results"][0]["smq_code"], "20000002")

        smq_term_code = self.client.get(
            "/api/smq/search", params={"version": self.version, "mode": "both", "query": "10039020"}
        ).json()
        self.assertTrue(any(row["smq_code"] == "20000002" for row in smq_term_code["results"]))

        smq_detail = self.client.get("/api/smq/20000002", params={"version": self.version, "mode": "both"}).json()
        self.assertTrue(smq_detail["found"])
        content = {row["term_code"]: row for row in smq_detail["content"]}
        self.assertEqual(content["10039020"]["scope_label"], "狭义")
        self.assertEqual(content["10069339"]["scope_label"], "广义")

        unified_smq = self.client.get("/api/details/SMQ/20000002", params={"version": self.version}).json()
        self.assertTrue(unified_smq["found"])
        self.assertEqual(unified_smq["level"], "SMQ")
        self.assertGreater(len(unified_smq["content"]), 0)

        export = self.client.post(
            "/api/export/csv",
            json={"filename": "smq.csv", "rows": smq_detail["content"][:3]},
        )
        self.assertEqual(export.status_code, 200)
        self.assertIn("term_code", export.text)

    def test_smq_child_smq_rows_are_labelled_and_named(self) -> None:
        # SMQ 20000005 (Hepatic disorders) contains child SMQ rows carrying
        # term_level='0'/term_scope='0' per the MSSO distribution file format.
        # These must not surface as a bare "0" with an empty name.
        detail = self.client.get("/api/smq/20000005", params={"version": self.version, "mode": "both"}).json()
        self.assertTrue(detail["found"])

        child_rows = [row for row in detail["content"] if row["scope"] == "0"]
        self.assertGreater(len(child_rows), 0)

        child_codes = {row["smq_code"] for row in detail["children"]}
        for row in child_rows:
            self.assertEqual(row["term_level"], "SMQ")
            self.assertEqual(row["scope_label"], "子级SMQ")
            self.assertTrue(row["en_name"] or row["zh_name"], f"child SMQ {row['term_code']} has no name")
            self.assertIn(row["term_code"], child_codes)

        # Regular member terms must keep their broad/narrow labelling.
        member_labels = {row["scope_label"] for row in detail["content"] if row["scope"] in {"1", "2"}}
        self.assertTrue(member_labels.issubset({"广义", "狭义"}))

    def test_csv_export_starts_with_utf8_bom_for_excel(self) -> None:
        # Excel on Chinese Windows reads CSV as GBK unless a UTF-8 BOM is present,
        # which would garble Chinese MedDRA terms.
        export = self.client.post(
            "/api/export/csv",
            json={"filename": "bom.csv", "rows": [{"code": "10039020", "name": "横纹肌溶解"}]},
        )
        self.assertEqual(export.status_code, 200)
        self.assertTrue(export.content.startswith(b"\xef\xbb\xbf"))
        self.assertIn("横纹肌溶解", export.content.decode("utf-8-sig"))

        empty = self.client.post("/api/export/csv", json={"filename": "empty.csv", "rows": []})
        self.assertEqual(empty.status_code, 200)
        self.assertEqual(empty.content, b"")

    def test_synonym_list_endpoint(self) -> None:
        synonyms = self.client.get("/api/synonyms", params={"version": self.version, "lang": "en", "limit": 20}).json()
        self.assertEqual(synonyms["lang"], "en")
        self.assertGreaterEqual(synonyms["count"], 0)
        self.assertIn("results", synonyms)
        self.assertLessEqual(len(synonyms["results"]), 20)

    def test_source_roots_endpoint_rejects_missing_path(self) -> None:
        roots = self.client.get("/api/source-roots").json()
        self.assertIn("roots", roots)
        self.assertFalse(any("path" in row for row in roots["roots"]))
        self.assertFalse(any(str(row.get("label", "")).startswith("词典来源") for row in roots["roots"]))

        bad = self.client.post("/api/source-roots", json={"path": "/definitely/not/a/meddra/source"})
        self.assertEqual(bad.status_code, 400)

    def test_source_root_picker_cancel_returns_json(self) -> None:
        with patch("app.main.pick_dictionary_directory", return_value=None):
            result = self.client.post("/api/source-roots/pick")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["status"], "cancelled")

    def test_business_api_returns_json_while_index_not_ready(self) -> None:
        with patch("app.main.index_status_for_config", return_value={"state": "running", "percent": 32}):
            result = self.client.get("/api/tree/soc", params={"version": self.version})
        self.assertEqual(result.status_code, 425)
        self.assertEqual(result.json()["detail"]["error"], "index_not_ready")

    def test_running_reindex_status_takes_priority_over_existing_current_index(self) -> None:
        config = default_source_config(self.version)
        key = index_job_key(config)
        with INDEX_LOCK:
            INDEX_JOBS[key] = {
                "version": self.version,
                "state": "running",
                "phase": "terms",
                "message": "载入术语文件",
                "percent": 12,
                "processed_rows": 1200,
                "total_rows": 10000,
                "started_at": 1,
                "updated_at": 2,
                "error": "",
            }
        try:
            status = index_status_for_config(config)
            self.assertEqual(status["state"], "running")
            self.assertEqual(status["percent"], 12)
            self.assertEqual(status["processed_rows"], 1200)
        finally:
            with INDEX_LOCK:
                INDEX_JOBS.pop(key, None)


if __name__ == "__main__":
    unittest.main()
