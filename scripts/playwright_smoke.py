from __future__ import annotations

import os
import re
from pathlib import Path

from playwright.sync_api import Browser, Page, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "playwright"
APP_URL = os.environ.get("MEDDRA_BROWSER_URL", "http://127.0.0.1:8765/")
SEARCH_PLACEHOLDER = "可输入AE/MH名称进行模糊查询或输入代码进行精确查询"
ADVANCED_PLACEHOLDER = "可输入AE/MH名称、中文/英文片段或代码"


def check_result_layout(page: Page, label: str) -> None:
    issues = page.locator(".center-pane .result").evaluate_all(
        """(rows) => {
          const selectors = [
            [".result-main .level-badge", "level"],
            [".result-main strong", "name"],
            [".result-main small", "subtitle"],
            [".result-main em", "code"],
            [".result-meta span:nth-child(1)", "match"],
            [".result-meta span:nth-child(2)", "field"],
            [".result-meta p", "reason"],
            [".result-actions", "actions"]
          ];
          const visibleRect = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || rect.width <= 1 || rect.height <= 1) return null;
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
          };
          const overlaps = [];
          rows.forEach((row, rowIndex) => {
            if (row.scrollWidth > row.clientWidth + 4) {
              overlaps.push({ row: rowIndex + 1, type: "row-overflow", width: row.clientWidth, scrollWidth: row.scrollWidth });
            }
            const parts = selectors.flatMap(([selector, name]) => Array.from(row.querySelectorAll(selector)).map((element, index) => {
              const rect = visibleRect(element);
              if (!rect) return null;
              return { label: index ? `${name}#${index + 1}` : name, text: (element.textContent || "").trim().slice(0, 32), rect };
            }).filter(Boolean));
            for (let i = 0; i < parts.length; i += 1) {
              for (let j = i + 1; j < parts.length; j += 1) {
                const a = parts[i];
                const b = parts[j];
                const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
                const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
                if (overlapX > 2 && overlapY > 2) {
                  overlaps.push({ row: rowIndex + 1, type: "text-overlap", a: `${a.label}:${a.text}`, b: `${b.label}:${b.text}` });
                }
              }
            }
          });
          return overlaps.slice(0, 8);
        }"""
    )
    if issues:
        raise AssertionError(f"{label}: text overlap or horizontal overflow: {issues}")


def expected_center_min(viewport_width: int) -> int:
    if viewport_width <= 1100:
        return 0
    if viewport_width >= 1700:
        return 900
    if viewport_width >= 1300:
        return round(viewport_width * 0.52)
    return round(viewport_width * 0.5)


def inspect_result_density(page: Page, label: str, viewport_width: int) -> None:
    metrics = page.evaluate(
        """() => {
          const center = document.querySelector(".center-pane");
          const group = document.querySelector(".center-pane .result-group");
          const row = document.querySelector(".center-pane .result");
          const main = document.querySelector(".center-pane .result-main");
          if (!center || !group || !row || !main) return { missing: true };
          const centerRect = center.getBoundingClientRect();
          const groupRect = group.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          const mainRect = main.getBoundingClientRect();
          const style = window.getComputedStyle(row);
          const columns = style.gridTemplateColumns.split(" ").filter(Boolean).length;
          return {
            missing: false,
            viewport: window.innerWidth,
            bodyWidth: document.documentElement.scrollWidth,
            centerWidth: centerRect.width,
            groupWidth: groupRect.width,
            rowHeight: rowRect.height,
            rowWidth: rowRect.width,
            rowScrollWidth: row.scrollWidth,
            mainWidth: mainRect.width,
            columns
          };
        }"""
    )
    if metrics.get("missing"):
        raise AssertionError(f"{label}: result metrics missing")
    if metrics["bodyWidth"] > metrics["viewport"] + 4:
        raise AssertionError(f"{label}: page overflow {metrics}")
    if metrics["rowScrollWidth"] > metrics["rowWidth"] + 4:
        raise AssertionError(f"{label}: result row overflow {metrics}")
    if metrics["groupWidth"] < metrics["centerWidth"] - 36:
        raise AssertionError(f"{label}: result group does not use center width {metrics}")
    min_center = expected_center_min(viewport_width)
    if min_center and metrics["centerWidth"] < min_center - 28:
        raise AssertionError(f"{label}: center pane below responsive budget {metrics}, expected >= {min_center}")
    if metrics["centerWidth"] >= 660:
        if metrics["columns"] < 3:
            raise AssertionError(f"{label}: wide result row collapsed into stacked layout {metrics}")
        if metrics["rowHeight"] > 118:
            raise AssertionError(f"{label}: wide result row too tall/crumpled {metrics}")
        if metrics["mainWidth"] < min(360, metrics["centerWidth"] * 0.48):
            raise AssertionError(f"{label}: main result area too narrow {metrics}")


def drag_pane(page: Page, side: str, delta: int) -> None:
    locator = page.locator(f".pane-resizer-{side}")
    box = locator.bounding_box()
    if not box:
        return
    x = box["x"] + box["width"] / 2
    y = box["y"] + 120
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + delta, y, steps=10)
    page.mouse.up()
    page.wait_for_timeout(120)


def ensure_search_results(page: Page) -> None:
    page.get_by_role("navigation").get_by_role("button", name="搜索", exact=True).click()
    search = page.get_by_placeholder(SEARCH_PLACEHOLDER)
    search.fill("横纹肌")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".result-group", has_text="包含匹配")).to_be_visible(timeout=15000)


def check_responsive_matrix(page: Page) -> list[str]:
    scenarios: list[str] = []
    for width in [980, 1180, 1366, 1440, 1600, 1920]:
        page.set_viewport_size({"width": width, "height": 900})
        page.evaluate(
            """() => {
              localStorage.removeItem("meddra.panes");
              localStorage.removeItem("meddra.history");
            }"""
        )
        page.reload(wait_until="networkidle")
        expect(page.get_by_role("navigation").get_by_role("button", name="搜索", exact=True)).to_have_class(
            re.compile(r"\bactive\b"), timeout=15000
        )
        ensure_search_results(page)
        check_result_layout(page, f"responsive {width} default")
        inspect_result_density(page, f"responsive {width} default", width)
        if width > 1100:
            for label, actions in [
                ("left-wide", [("left", 260)]),
                ("right-wide", [("right", -260)]),
                ("both-attempted-wide", [("left", 260), ("right", -260)]),
                ("both-narrowed", [("left", -180), ("right", 180)])
            ]:
                for side, delta in actions:
                    drag_pane(page, side, delta)
                ensure_search_results(page)
                check_result_layout(page, f"responsive {width} {label}")
                inspect_result_density(page, f"responsive {width} {label}", width)
        page.screenshot(path=str(OUTPUT / f"responsive-{width}.png"), full_page=True)
        scenarios.append(f"responsive matrix {width}px")
    return scenarios


def run(page: Page) -> list[str]:
    checks: list[str] = []
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    page.goto(APP_URL, wait_until="networkidle")
    page.evaluate(
        """() => {
          localStorage.removeItem("meddra.bin");
          localStorage.removeItem("meddra.history");
          localStorage.removeItem("meddra.panes");
        }"""
    )
    page.reload(wait_until="networkidle")

    expect(page.locator(".module-nav button.active", has_text="搜索")).to_be_visible(timeout=15000)
    expect(page.get_by_text("建议最大化窗口后使用")).to_be_visible()
    expect(page.locator(".brand img")).to_be_visible()
    logo_loaded = page.locator(".brand img").evaluate("(node) => node.complete && node.naturalWidth >= 64")
    assert logo_loaded, "brand logo did not load"
    checks.append("logo and maximized-window tip loaded")

    expect(page.locator(".version-select")).to_be_visible()
    options = page.locator(".version-select option").all_text_contents()
    assert any("MedDRA 29.0" in item for item in options), options
    assert all(("双语" in item or "仅中文" in item or "仅英文" in item) for item in options), options
    checks.append("version selector includes language labels")

    expect(page.locator(".level-filter button.active", has_text="PT")).to_be_visible()
    expect(page.locator(".level-filter button", has_text="SMQ")).to_be_visible()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUTPUT / "logo-desktop.png"), full_page=True)

    page.get_by_role("button", name="英文").click()
    expect(page.locator(".segmented button.active", has_text="英文")).to_be_visible()
    page.get_by_role("button", name="双语").click()
    checks.append("database display mode switches")

    search = page.get_by_placeholder(SEARCH_PLACEHOLDER)
    expect(search).to_have_value("")
    checks.append("search placeholder without example value")
    search.fill("rhabdomyolisys")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.get_by_text("模糊候选").first).to_be_visible(timeout=15000)
    expect(page.get_by_text("Rhabdomyolysis").first).to_be_visible()
    fuzzy_meta = page.locator(".result.fuzzy .result-meta").first.text_content() or ""
    assert "模糊相似度" not in fuzzy_meta, fuzzy_meta
    check_result_layout(page, "fuzzy search")
    checks.append("fuzzy search without visible score")

    page.locator(".result-main").first.click()
    expect(page.locator(".center-pane .detail-workspace")).to_be_visible()
    expect(page.locator(".right-pane .relationship-tree-node.current", has_text="Rhabdomyolysis")).to_be_visible()
    expect(page.locator(".right-pane .relationship-tree-node", has_text="Musculoskeletal")).to_be_visible()
    pseudo_line = page.locator(".right-pane .relationship-tree-node.current").first.evaluate(
        """(node) => getComputedStyle(node, "::before").content"""
    )
    assert pseudo_line in ("none", "normal", ""), pseudo_line
    expect(page.locator(".right-pane .relationship-tree-toggle", has_text="直接子级")).to_be_visible()
    page.locator(".right-pane .relationship-tree-toggle", has_text="直接子级").first.click()
    expect(page.locator(".right-pane .relationship-tree-children .relationship-tree-node", has_text="LLT").first).to_be_visible()
    page.screenshot(path=str(OUTPUT / "v3-detail-tree.png"), full_page=True)
    checks.append("detail and relationship tree without connector lines")

    page.get_by_role("button", name="搜索", exact=True).click()
    page.locator('.result-actions button[title="加入Research Bin"]').first.click()
    expect(page.get_by_text("已加入").first).to_be_visible()
    search.fill("10039020")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".result-group", has_text="代码匹配")).to_be_visible()
    expect(page.get_by_text("横纹肌溶解").first).to_be_visible()
    check_result_layout(page, "code search")
    checks.append("code search in unified box")

    left_before = page.locator(".left-pane").bounding_box()
    left_resizer = page.locator(".pane-resizer-left").bounding_box()
    assert left_before and left_resizer, "left pane or resizer missing"
    page.mouse.move(left_resizer["x"] + left_resizer["width"] / 2, left_resizer["y"] + 60)
    page.mouse.down()
    page.mouse.move(left_resizer["x"] + 84, left_resizer["y"] + 60, steps=8)
    page.mouse.up()
    left_after = page.locator(".left-pane").bounding_box()
    assert left_after and left_after["width"] > left_before["width"] + 36, (left_before, left_after)
    checks.append("left pane resize")

    right_before = page.locator(".right-pane").bounding_box()
    right_resizer = page.locator(".pane-resizer-right").bounding_box()
    assert right_before and right_resizer, "right pane or resizer missing"
    page.mouse.move(right_resizer["x"] + right_resizer["width"] / 2, right_resizer["y"] + 60)
    page.mouse.down()
    page.mouse.move(right_resizer["x"] - 84, right_resizer["y"] + 60, steps=8)
    page.mouse.up()
    right_after = page.locator(".right-pane").bounding_box()
    assert right_after and right_after["width"] > right_before["width"] + 36, (right_before, right_after)
    checks.append("right pane resize")

    search.fill("横纹肌")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".result-group", has_text="包含匹配")).to_be_visible()
    check_result_layout(page, "narrow center search")
    page.screenshot(path=str(OUTPUT / "logo-narrow-search.png"), full_page=True)
    checks.append("narrow results no overlap")
    checks.extend(check_responsive_matrix(page))

    page.get_by_role("button", name="高级搜索").click()
    advanced_inputs = page.locator(f'input[placeholder="{ADVANCED_PLACEHOLDER}"]')
    expect(advanced_inputs).to_have_count(2)
    expect(advanced_inputs.nth(0)).to_have_value("")
    expect(advanced_inputs.nth(1)).to_have_value("")
    advanced_inputs.nth(0).fill("renal")
    advanced_inputs.nth(1).fill("failure")
    page.locator(".advanced-grid button.primary").click()
    expect(page.locator(".result-list .result").first).to_be_visible()
    check_result_layout(page, "advanced search")
    checks.append("advanced search")

    page.get_by_role("button", name="搜索", exact=True).click()
    page.locator(".level-filter button", has_text="SMQ").click()
    search.fill("横纹肌")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".result-group", has_text="SMQ匹配")).to_be_visible()
    page.locator(".result-group", has_text="SMQ匹配").locator(".result-main").first.click()
    expect(page.locator(".center-pane .detail-workspace", has_text="SMQ")).to_be_visible()
    expect(page.locator(".right-pane .relationship-tree-node.current", has_text="横纹肌溶解/肌病")).to_be_visible()
    page.locator(".right-pane .relationship-tree-toggle", has_text="包含术语").first.click()
    expect(page.get_by_text("狭义").first).to_be_visible()
    with page.expect_download() as smq_download:
        page.locator("button", has_text="导出SMQ").click()
    smq_download.value.save_as(str(OUTPUT / "smq-export.csv"))
    checks.append("SMQ detail and export")

    page.locator(".module-nav button", has_text="Research Bin").click()
    expect(page.locator(".result-list .result").first).to_be_visible()
    expect(page.locator("button", has_text="移除").first).to_be_visible()
    check_result_layout(page, "research bin")
    with page.expect_download() as bin_download:
        page.locator("button", has_text="导出JSON").click()
    bin_download.value.save_as(str(OUTPUT / "research-bin.json"))
    checks.append("Research Bin export")

    page.get_by_role("button", name="设置").click()
    expect(page.get_by_text("词典来源导入")).to_be_visible()
    expect(page.get_by_text("mdhier.asc")).to_be_visible()
    expect(page.get_by_role("button", name="加入来源")).to_be_visible()
    expect(page.get_by_placeholder("也可手动粘贴词典文件夹路径")).to_be_visible()
    settings_text = page.locator(".settings-panel").text_content() or ""
    assert "/Users/" not in settings_text and ".sqlite" not in settings_text, settings_text
    with page.expect_response(lambda response: "/api/synonyms" in response.url and response.ok):
        page.get_by_role("button", name="查看中文同义词表").click()
    expect(page.locator(".synonym-status")).to_contain_text(re.compile(r"已载入|未找到"))
    checks.append("settings and synonym table")

    page.set_viewport_size({"width": 390, "height": 820})
    page.screenshot(path=str(OUTPUT / "desktop-narrow-settings.png"), full_page=True)
    body_width = page.evaluate("document.documentElement.scrollWidth")
    viewport_width = page.evaluate("window.innerWidth")
    assert body_width <= viewport_width + 4, (body_width, viewport_width)
    checks.append("desktop narrow window no page overflow")

    if console_errors:
        raise AssertionError("browser console errors: " + " | ".join(console_errors))
    return checks


def check_mobile_gate(browser: Browser) -> list[str]:
    context = browser.new_context(
        viewport={"width": 390, "height": 820},
        is_mobile=True,
        has_touch=True,
        user_agent=(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        ),
    )
    page = context.new_page()
    try:
        page.goto(APP_URL, wait_until="networkidle")
        expect(page.get_by_text("建议使用电脑端打开")).to_be_visible(timeout=15000)
        expect(page.get_by_text("Mac 或 Windows")).to_be_visible()
        page.screenshot(path=str(OUTPUT / "mobile-desktop-recommendation.png"), full_page=True)
        body_width = page.evaluate("document.documentElement.scrollWidth")
        viewport_width = page.evaluate("window.innerWidth")
        assert body_width <= viewport_width + 4, (body_width, viewport_width)
        return ["mobile device shows desktop recommendation"]
    finally:
        context.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 960}, accept_downloads=True)
        try:
            checks = run(page)
            checks.extend(check_mobile_gate(browser))
        finally:
            browser.close()
    print("Playwright smoke passed:")
    for check in checks:
        print(f"- {check}")


if __name__ == "__main__":
    main()
