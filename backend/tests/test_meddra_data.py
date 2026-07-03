from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

if not os.environ.get("MEDDRA_SOURCE_ROOT"):
    os.environ["MEDDRA_SOURCE_ROOT"] = str(Path(__file__).resolve().parents[3])

from app.meddra_data import (
    REQUIRED_ASC_FILES,
    MeddraIndexer,
    MeddraStore,
    default_source_config,
    discover_releases,
    fuzzy_score,
    select_release,
    split_dollar_line,
    version_slug,
)


EXPECTED_COUNTS = {
    "soc.asc": 27,
    "hlgt.asc": 337,
    "hlt.asc": 1739,
    "pt.asc": 27361,
    "llt.asc": 91082,
    "mdhier.asc": 42530,
    "hlt_pt.asc": 40213,
    "hlgt_hlt.asc": 1757,
    "soc_hlgt.asc": 354,
    "smq_list.asc": 230,
    "smq_content.asc": 98140,
}


class MeddraDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = default_source_config("29.0")
        MeddraIndexer(cls.config).ensure_index(force=True)
        cls.store = MeddraStore(cls.config)

    def test_release_discovery_keeps_29_0_as_test_fixture_not_hardcoded_default(self) -> None:
        releases = {row.version: row for row in discover_releases()}
        self.assertIn("29.0", releases)
        self.assertTrue(releases["29.0"].complete)
        self.assertTrue(default_source_config("29.0").db_path.name.endswith(f"{version_slug('29.0')}.sqlite"))

    def test_clean_install_has_no_implicit_dictionary_binding(self) -> None:
        with TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"MEDDRA_BROWSER_STATE_DIR": tmp}, clear=False):
                os.environ.pop("MEDDRA_SOURCE_ROOT", None)
                self.assertEqual(discover_releases(), [])
                with self.assertRaisesRegex(RuntimeError, "未发现可用的MedDRA"):
                    default_source_config()

    def test_release_discovery_allows_single_language_release(self) -> None:
        with TemporaryDirectory() as tmp:
            base = Path(tmp) / "MedDRA_30_1_English" / "MedAscii"
            base.mkdir(parents=True)
            for file_name in REQUIRED_ASC_FILES:
                (base / file_name).write_text("", encoding="utf-8")
            release = select_release(discover_releases(Path(tmp)), "30.1")
            self.assertFalse(release.complete)
            self.assertEqual(release.available_languages, ("en",))
            self.assertEqual(release.missing_languages, ("zh",))

    def test_source_counts_match_local_29_0_distribution(self) -> None:
        status = self.store.status()
        self.assertEqual(status["version"], "29.0")
        counts = {(row["lang"], row["file_name"]): row["row_count"] for row in status["counts"]}
        for lang in ["en", "zh"]:
            for file_name, expected in EXPECTED_COUNTS.items():
                self.assertEqual(counts[(lang, file_name)], expected, (lang, file_name))

    def test_golden_terms_have_bilingual_names_and_hierarchy(self) -> None:
        rhabdo = self.store.details("PT", "10039020")
        self.assertEqual(rhabdo["term"]["en_name"], "Rhabdomyolysis")
        self.assertEqual(rhabdo["term"]["zh_name"], "横纹肌溶解")
        self.assertTrue(any(row["primary_soc"] == "Y" for row in rhabdo["hierarchies"]))
        self.assertTrue(
            any(row["en_soc_name"] == "Musculoskeletal and connective tissue disorders" for row in rhabdo["hierarchies"])
        )

        aki = self.store.details("PT", "10069339")
        self.assertEqual(aki["term"]["zh_name"], "急性肾损伤")
        self.assertTrue(any(row["en_soc_name"] == "Renal and urinary disorders" for row in aki["hierarchies"]))

        torsade = self.store.details("PT", "10044066")
        self.assertEqual(torsade["term"]["zh_name"], "尖端扭转型室速")
        self.assertTrue(any(row["en_soc_name"] == "Cardiac disorders" for row in torsade["hierarchies"]))

    def test_smq_scope_examples(self) -> None:
        smq = self.store.smq_details("20000002")
        content = {row["term_code"]: row for row in smq["content"]}
        self.assertEqual(content["10039020"]["scope_label"], "狭义")
        self.assertEqual(content["10069339"]["scope_label"], "广义")

    def test_exact_contains_code_and_chinese_search(self) -> None:
        exact = self.store.search("Rhabdomyolysis", mode="en")
        self.assertEqual(exact["groups"][0]["category"], "exact")
        self.assertEqual(exact["groups"][0]["results"][0]["code"], "10039020")

        zh = self.store.search("横纹肌", mode="zh")
        categories = {group["category"] for group in zh["groups"]}
        self.assertIn("contains", categories)

        code = self.store.search("10039020", mode="both")
        categories = {group["category"] for group in code["groups"]}
        self.assertIn("code", categories)

    def test_search_defaults_to_pt_and_can_include_smq(self) -> None:
        result = self.store.search("横纹肌", mode="zh", include_synonyms=False)
        self.assertGreater(result["count"], 0)
        for group in result["groups"]:
            self.assertTrue(all(row["level"] == "PT" for row in group["results"]))

        smq = self.store.search("横纹肌", mode="zh", include_synonyms=False, levels=["SMQ"])
        smq_groups = [group for group in smq["groups"] if group["category"] == "smq"]
        self.assertTrue(smq_groups)
        self.assertEqual(smq_groups[0]["results"][0]["level"], "SMQ")
        self.assertTrue(any(row["code"] == "20000002" for row in smq_groups[0]["results"]))

    def test_fuzzy_search_is_labeled_and_scores_typo(self) -> None:
        score = fuzzy_score("rhabdomyolisys", "rhabdomyolysis")
        self.assertGreaterEqual(score, 85)
        result = self.store.search("rhabdomyolisys", mode="en", include_synonyms=False)
        fuzzy_groups = [group for group in result["groups"] if group["category"] == "fuzzy"]
        self.assertTrue(fuzzy_groups)
        first = fuzzy_groups[0]["results"][0]
        self.assertEqual(first["category_label"], "模糊候选")
        self.assertIn("近似文本候选", first["reason"])
        self.assertNotIn("模糊相似度", first["reason"])

        chinese = self.store.search("横纹肌融解", mode="zh", include_synonyms=False, levels=["PT", "LLT"])
        chinese_fuzzy = [group for group in chinese["groups"] if group["category"] == "fuzzy"]
        self.assertTrue(chinese_fuzzy)
        self.assertEqual(chinese_fuzzy[0]["results"][0]["code"], "10039020")
        self.assertEqual(chinese_fuzzy[0]["results"][0]["level"], "PT")

    def test_same_code_pt_llt_dedup_prefers_pt(self) -> None:
        lookup = self.store.code_lookup("10039020")
        self.assertEqual([row["term"]["level"] for row in lookup["matches"]], ["PT"])
        exact = self.store.search("横纹肌溶解", mode="zh", include_synonyms=False, levels=["PT", "LLT"])
        rows = exact["groups"][0]["results"]
        self.assertEqual(rows[0]["code"], "10039020")
        self.assertEqual(rows[0]["level"], "PT")
        self.assertEqual(sum(1 for row in rows if row["code"] == "10039020"), 1)

    def test_fuzzy_false_positive_suppression(self) -> None:
        result = self.store.search("zzzxxyqnotameddraterm", mode="en", include_synonyms=False)
        self.assertEqual(result["count"], 0)

    def test_same_score_results_sort_by_numeric_code(self) -> None:
        result = self.store.search("renal", mode="en", include_synonyms=False, levels=["PT"])
        contains = [group for group in result["groups"] if group["category"] == "contains"][0]["results"]
        codes = [row["code"] for row in contains[:20]]
        self.assertEqual(codes, sorted(codes, key=int))
        self.assertTrue(all(row["score"] == contains[0]["score"] for row in contains[:20]))

    def test_advanced_search_boolean(self) -> None:
        result = self.store.advanced_search(
            {
                "mode": "en",
                "levels": ["PT"],
                "boolean": "AND",
                "conditions": [
                    {"value": "renal", "operator": "contains"},
                    {"value": "failure", "operator": "contains"},
                ],
            }
        )
        self.assertGreater(result["count"], 0)

    def test_tree_and_analysis_endpoints_data(self) -> None:
        roots = self.store.tree("soc", mode="zh")
        self.assertEqual(len(roots["nodes"]), 27)
        self.assertTrue(all("display_name" in row for row in roots["nodes"]))
        self.assertEqual(roots["nodes"][0]["code"], "10005329")

        smq_roots = self.store.tree("smq", mode="zh")
        self.assertEqual(smq_roots["nodes"][0]["code"], "20000001")

        smq = self.store.smq_search("横纹肌", mode="zh")
        self.assertGreaterEqual(smq["count"], 1)
        self.assertEqual(smq["results"][0]["smq_code"], "20000002")

        analysis = self.store.smq_analysis("10039020", "PT")
        self.assertGreater(analysis["count"], 0)

    def test_details_include_relationships_and_unified_smq(self) -> None:
        pt = self.store.details("PT", "10039020")
        relationships = pt["relationships"]
        self.assertTrue(any(row["level"] == "HLT" for row in relationships["parents"]))
        self.assertTrue(any(row["level"] == "LLT" for row in relationships["children"]))
        self.assertGreater(len(relationships["hierarchy_paths"]), 0)
        self.assertGreater(len(relationships["smq_memberships"]), 0)

        hlt_code = pt["hierarchies"][0]["hlt_code"]
        hlt = self.store.details("HLT", hlt_code)
        self.assertTrue(any(row["level"] == "HLGT" for row in hlt["relationships"]["parents"]))
        self.assertTrue(any(row["level"] == "PT" for row in hlt["relationships"]["children"]))

        smq = self.store.details("SMQ", "20000002")
        self.assertTrue(smq["found"])
        self.assertEqual(smq["level_label"], "标准MedDRA查询")
        self.assertGreater(len(smq["content"]), 0)

    def test_split_dollar_line_preserves_quotes_and_inner_delimiters(self) -> None:
        parts = split_dollar_line('10000001$"Ventilation" pneumonitis$10081988$$$$$$$N$$')
        self.assertEqual(parts[1], '"Ventilation" pneumonitis')
        embedded = split_dollar_line('1$"A$B"$3$')
        self.assertEqual(embedded[:3], ["1", '"A$B"', "3"])


if __name__ == "__main__":
    unittest.main()
