"""Run the shipped entry page's script with controlled DOM and network events."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import unittest


ENTRY = Path(__file__).resolve().parents[2] / "portable-index.html"
HINT = {"port": 49123, "instance_id": "a" * 32, "distribution_mode": "portable"}


@unittest.skipUnless(shutil.which("node"), "Node is required to run the entry page JavaScript")
class PortableEntryPageTests(unittest.TestCase):
    def exercise(self, hint=None, live=None, blocked=False):
        source = ENTRY.read_text(encoding="utf-8").split("<script>", 1)[1].split("</script>", 1)[0]
        before = """
            const nodes = new Map();
            const actions = { visits: [], probes: [] };
            global.window = { location: { replace(url) { actions.visits.push(url); } } };
            global.document = {
              querySelector(selector) {
                if (!nodes.has(selector)) nodes.set(selector, { addEventListener() {} });
                return nodes.get(selector);
              },
              createElement() { return { remove() {} }; },
              head: { append(script) {
                if (hint) window.__MEDDRA_PORTABLE_RUNTIME = hint;
                queueMicrotask(() => script.onload());
              } }
            };
            global.fetch = async (url) => {
              actions.probes.push(url);
              if (blocked) throw new Error("browser declined local access");
              return { ok: true, async json() { return live; } };
            };
        """
        after = """
            process.stdout.write(JSON.stringify({
              ...actions, status: nodes.get("#status").textContent, manual: !nodes.get("#manual").hidden
            }));
        """
        values = f"const [hint, live, blocked] = {json.dumps([hint, live, blocked])};"
        script = values + before + source.replace("    detect();", "    await detect();") + after
        result = subprocess.run(["node", "--input-type=module", "-e", script],
                                check=True, capture_output=True, text=True, timeout=10)
        return json.loads(result.stdout)

    def test_follows_only_the_matching_live_instance(self):
        result = self.exercise(HINT, HINT)
        self.assertEqual(result["visits"], ["http://127.0.0.1:49123/"])
        self.assertEqual(result["probes"], ["http://127.0.0.1:49123/api/runtime-info"])

    def test_stale_or_foreign_instance_does_not_navigate(self):
        for live in (None, dict(HINT, instance_id="b" * 32), dict(HINT, distribution_mode="free_mac")):
            result = self.exercise(HINT, live)
            self.assertEqual(result["visits"], [])
            self.assertIn("已失效", result["status"])

    def test_missing_address_never_scans_ports(self):
        for hint in (None, dict(HINT, port=65536), dict(HINT, instance_id="invalid")):
            result = self.exercise(hint)
            self.assertFalse(result["visits"])
            self.assertFalse(result["probes"])

    def test_manual_recovery_when_browser_blocks_detection(self):
        result = self.exercise(HINT, blocked=True)
        self.assertFalse(result["visits"])
        self.assertTrue(result["manual"])
        self.assertIn("无法确认", result["status"])


if __name__ == "__main__":
    unittest.main()
