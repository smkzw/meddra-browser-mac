from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "playwright"
SEARCH_PLACEHOLDER = "可输入AE/MH名称进行模糊查询或输入代码进行精确查询"
ADVANCED_PLACEHOLDER = "可输入AE/MH名称、中文/英文片段或代码"


def wait_ready(page, timeout=180000) -> None:
    page.wait_for_function(
        """() => {
          const notice = document.querySelector(".status-notice");
          const select = document.querySelector(".version-select");
          const progress = document.querySelector(".index-progress-panel:not(.is-hidden)");
          if (progress) return false;
          return Boolean(select && select.value && !notice);
        }""",
        timeout=timeout,
    )


def flash_gone(page) -> None:
    page.wait_for_timeout(200)


def run_file_entry(page, html_path: Path, expected_url: str) -> str:
    page.goto(html_path.resolve().as_uri(), wait_until="domcontentloaded")
    page.wait_for_url(lambda url: url.startswith(expected_url.rstrip("/")), timeout=15000)
    return page.url


def run_ui(page, app_url: str) -> list[str]:
    checks: list[str] = []
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.goto(app_url, wait_until="domcontentloaded")
    page.evaluate(
        """() => {
          localStorage.removeItem("meddra.bin");
          localStorage.removeItem("meddra.history");
          localStorage.removeItem("meddra.panes");
        }"""
    )
    page.reload(wait_until="domcontentloaded")
    wait_ready(page)
    expect(page.locator(".brand h1")).to_have_text("MedDRA Browser")
    expect(page.get_by_text("建议最大化窗口后使用")).to_be_visible()
    header = page.locator(".app-header").inner_text()
    assert "Mac.app" not in header
    assert "App Store" not in header
    checks.append("ready header without Mac/App Store branding")

    runtime = page.evaluate("async () => (await fetch('/api/runtime-info')).json()")
    assert runtime["distribution_mode"] == "portable"
    assert runtime["app_store_mode"] is False
    assert runtime["version"] == "0.1.12"
    checks.append("runtime-info is portable 0.1.12 not app-store")

    page.get_by_role("button", name="英文").click()
    expect(page.locator(".segmented button.active", has_text="英文")).to_be_visible()
    page.get_by_role("button", name="中文").click()
    page.get_by_role("button", name="双语").click()
    checks.append("language mode switches")

    search = page.get_by_placeholder(SEARCH_PLACEHOLDER)
    search.fill("")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".empty-state").first).to_be_visible()
    checks.append("empty search shows empty state")

    search.fill("rhabdomyolisys")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.get_by_text("模糊候选").first).to_be_visible(timeout=20000)
    expect(page.get_by_text("Rhabdomyolysis").first).to_be_visible()
    checks.append("fuzzy search")

    page.locator(".result-main").first.click()
    expect(page.locator(".center-pane .detail-workspace")).to_be_visible()
    expect(page.locator(".right-pane .relationship-tree-node.current").first).to_be_visible()
    if page.locator(".right-pane .relationship-tree-toggle", has_text="直接子级").count():
        page.locator(".right-pane .relationship-tree-toggle", has_text="直接子级").first.click()
    checks.append("detail and relationship tree")

    page.get_by_role("button", name="搜索", exact=True).click()
    page.locator('.result-actions button[title="加入Research Bin"]').first.click()
    expect(page.get_by_text("已加入").first).to_be_visible()
    checks.append("research bin add")

    search.fill("10039020")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".result-group", has_text="代码匹配")).to_be_visible()
    expect(page.get_by_text("横纹肌溶解").first).to_be_visible()
    checks.append("exact code search")

    search.fill("横纹肌")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".result-group", has_text="包含匹配")).to_be_visible()
    checks.append("contains search")

    for level in ["LLT", "HLT", "HLGT", "SOC", "SMQ"]:
        page.locator(".level-filter button", has_text=level).click()
        expect(page.locator(".level-filter button.active", has_text=level)).to_be_visible()
    search.fill("横纹肌")
    page.locator(".center-pane .query-bar button.primary").click()
    expect(page.locator(".result-group", has_text="SMQ匹配")).to_be_visible()
    page.locator(".result-group", has_text="SMQ匹配").locator(".result-main").first.click()
    expect(page.locator(".center-pane .detail-workspace", has_text="SMQ")).to_be_visible()
    checks.append("level filters including SMQ")

    page.get_by_role("button", name="搜索", exact=True).click()
    page.locator(".level-filter button", has_text="PT").click()
    if page.locator("label", has_text="使用同义词表").locator("input").is_checked():
        page.locator("label", has_text="使用同义词表").click()
    page.locator("label", has_text="显示非当前LLT").click()
    page.locator("label", has_text="显示非当前LLT").click()
    checks.append("synonym and non-current toggles")

    if page.locator("label", has_text="SOC过滤").count():
        options = page.locator("label", has_text="SOC过滤").locator("option")
        if options.count() > 1:
            value = options.nth(1).get_attribute("value") or ""
            if value:
                page.locator("label", has_text="SOC过滤").locator("select").select_option(value)
                search.fill("横纹肌")
                page.locator(".center-pane .query-bar button.primary").click()
                page.wait_for_timeout(400)
    checks.append("SOC filter exercised")

    page.get_by_role("button", name="高级搜索").click()
    inputs = page.locator(f'input[placeholder="{ADVANCED_PLACEHOLDER}"]')
    inputs.nth(0).fill("renal")
    inputs.nth(1).fill("failure")
    page.locator(".advanced-grid button.primary").click()
    expect(page.locator(".result-list .result").first).to_be_visible()
    page.locator(".advanced-grid select").nth(1).select_option("OR")
    page.locator(".advanced-grid button.primary").click()
    expect(page.locator(".result-list .result").first).to_be_visible()
    page.locator(".advanced-grid select").nth(1).select_option("NOT")
    page.locator(".advanced-grid button.primary").click()
    page.wait_for_timeout(400)
    checks.append("advanced boolean AND/OR/NOT")

    page.locator("button", has_text="SOC层级").click()
    expect(page.locator(".tree-label").first).to_be_visible()
    page.locator(".tree-toggle").first.click()
    page.wait_for_timeout(500)
    page.locator(".tree-label").first.click()
    expect(page.locator(".center-pane .detail-workspace")).to_be_visible()
    page.locator("button", has_text="SMQ层级").click()
    expect(page.locator(".tree-label").first).to_be_visible()
    checks.append("SOC/SMQ tree navigation")

    page.get_by_role("navigation").get_by_role("button", name="Research Bin").click()
    expect(page.locator(".result-list .result").first).to_be_visible()
    with page.expect_download() as bin_json:
        page.locator("button", has_text="导出JSON").click()
    bin_json.value.save_as(str(OUTPUT / "qa-research-bin.json"))
    with page.expect_download() as bin_csv:
        page.locator("button", has_text="导出CSV").click()
    bin_csv.value.save_as(str(OUTPUT / "qa-research-bin.csv"))
    page.locator("button", has_text="移除").first.click()
    expect(page.get_by_text("暂无结果")).to_be_visible()
    clear_bin = page.locator(".module .query-bar button", has_text="清空")
    expect(clear_bin).to_be_disabled()
    checks.append("research bin export/remove/clear")

    page.get_by_role("button", name="历史记录").click()
    expect(page.locator(".history-list button").first).to_be_visible()
    checks.append("history list")

    page.get_by_role("button", name="设置").click()
    expect(page.get_by_text("绑定 MedDRA 词典文件夹")).to_be_visible()
    settings = page.locator(".settings-panel").inner_text()
    assert "Mac.app" not in settings
    assert "词典来源 1" not in settings
    page.get_by_placeholder("找不到选择窗口时，可把词典文件夹路径粘贴到这里").fill("/definitely/not/a/meddra/source")
    page.get_by_role("button", name="手动加入路径").click()
    page.wait_for_timeout(800)
    toast = page.locator(".toast")
    if toast.count():
        assert "未在所选文件夹" in toast.inner_text() or "不存在" in toast.inner_text()
    page.get_by_placeholder("找不到选择窗口时，可把词典文件夹路径粘贴到这里").fill("")
    page.get_by_role("button", name="手动加入路径").click()
    page.wait_for_timeout(400)
    page.get_by_role("button", name="查看中文同义词表").click()
    expect(page.locator(".synonym-status")).to_be_visible(timeout=15000)
    checks.append("settings invalid/empty path and synonym preview")

    page.get_by_role("button", name="搜索", exact=True).click()
    page.locator(".center-pane .query-bar button", has_text="清除").click()
    expect(search).to_have_value("")
    checks.append("clear search")

    page.set_viewport_size({"width": 390, "height": 820})
    page.wait_for_timeout(200)
    page.set_viewport_size({"width": 1440, "height": 960})
    checks.append("viewport resize")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUTPUT / "qa-round-desktop.png"), full_page=True)
    unexpected = [item for item in console_errors if "400 (Bad Request)" not in item]
    if unexpected:
        raise AssertionError("browser console errors: " + " | ".join(unexpected[:8]))
    return checks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=os.environ.get("MEDDRA_BROWSER_URL", "http://127.0.0.1:8861/"))
    parser.add_argument("--html", default="")
    parser.add_argument("--skip-ui", action="store_true")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results = {"file_entry": None, "ui": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 960}, accept_downloads=True)
        try:
            if args.html:
                results["file_entry"] = run_file_entry(page, Path(args.html), args.url)
            if not args.skip_ui:
                results["ui"] = run_ui(page, args.url)
        finally:
            browser.close()
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
