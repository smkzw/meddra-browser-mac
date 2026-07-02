from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from app.main import app


class ApiManualCoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        cls.version = "29.0"

    def test_status_and_version_discovery(self) -> None:
        status = self.client.get("/api/status", params={"version": self.version}).json()
        self.assertEqual(status["version"], self.version)
        self.assertTrue(status["db_path"].endswith("meddra_29_0.sqlite"))
        self.assertIn("available_versions", status)

        releases = self.client.get("/api/releases").json()["releases"]
        self.assertTrue(any(row["version"] == self.version and row["complete"] for row in releases))
        self.assertIn("PT", status["search_levels"])
        self.assertIn("SMQ", status["search_levels"])

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

    def test_synonym_list_endpoint(self) -> None:
        synonyms = self.client.get("/api/synonyms", params={"version": self.version, "lang": "en", "limit": 20}).json()
        self.assertEqual(synonyms["lang"], "en")
        self.assertGreater(synonyms["count"], 0)
        self.assertLessEqual(len(synonyms["results"]), 20)

    def test_source_roots_endpoint_rejects_missing_path(self) -> None:
        roots = self.client.get("/api/source-roots").json()
        self.assertIn("roots", roots)

        bad = self.client.post("/api/source-roots", json={"path": "/definitely/not/a/meddra/source"})
        self.assertEqual(bad.status_code, 400)


if __name__ == "__main__":
    unittest.main()
