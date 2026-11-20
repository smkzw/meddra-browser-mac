from unittest import TestCase

from app.meddra_data import MeddraStore


class SyntheticSearchStore(MeddraStore):
    def __init__(self) -> None:
        # Exercise both search paths without reading a licensed dictionary.
        self.rows = tuple(
            {"level": "PT", "code": str(90000000 + i), "en_name": "Fixture", "is_current": "Y"}
            for i in range(175)
        )

    def all_terms(self):
        return self.rows


class SearchPagingTests(TestCase):
    def test_simple_search_totals_and_complete_paging(self):
        store = SyntheticSearchStore()
        pages = [
            store.search("Fixture", mode="en", include_synonyms=False, offset_per_group=offset, limit_per_group=80)
            for offset in (0, 80, 160)
        ]
        self.assertEqual([page["count"] for page in pages], [80, 80, 15])
        self.assertEqual([page["total_count"] for page in pages], [175, 175, 175])
        self.assertEqual([page["next_offset"] for page in pages], [80, 160, None])
        codes = {row["code"] for page in pages for group in page["groups"] for row in group["results"]}
        self.assertEqual(len(codes), 175)

    def test_advanced_search_has_total_independent_of_limit(self):
        result = SyntheticSearchStore().advanced_search({
            "conditions": [{"value": "Fixture"}], "mode": "en", "offset": 100, "limit": 50,
        })
        self.assertEqual(result["count"], 50)
        self.assertEqual(result["total_count"], 175)
        self.assertEqual(result["next_offset"], 150)
        self.assertEqual(result["results"][0]["code"], "90000100")
