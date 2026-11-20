"""Browser regression against a built workbench with licensed dictionaries.

Set MEDDRA_BROWSER_URL and use an isolated state directory. Screenshots and CSVs
stay in the ignored output directory and are not part of the release ZIP.
"""

from __future__ import annotations

import csv
import io
import os
from pathlib import Path
import re

from playwright.sync_api import Browser, Page, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "playwright"
APP_URL = os.environ.get("MEDDRA_BROWSER_URL", "http://127.0.0.1:8765/")


def module_button(page: Page, label: str):
    selector = ".app-header" if label == "设置" and page.locator(".app-header").get_by_role("button", name=label, exact=True).count() else ".module-nav"
    return page.locator(selector).get_by_role("button", name=re.compile(rf"^{re.escape(label)}(?:\s*\d+)?$"))


def search(page: Page, query: str) -> None:
    module_button(page, "搜索").click()
    field = page.locator(".center-pane .query-bar input").first
    field.fill(query)
    with page.expect_response(lambda response: ("/api/search" in response.url or "/api/code/" in response.url) and response.ok):
        field.press("Enter")
    expect(page.locator(".result-main").first).to_be_visible(timeout=20_000)


def ready(page: Page, version: str) -> None:
    page.wait_for_function(
        """async version => {
            const response = await fetch('/api/index-status?version=' + encodeURIComponent(version));
            return response.ok && (await response.json()).state === 'ready';
        }""",
        arg=version,
        timeout=120_000,
    )
    expect(page.locator(".center-pane .query-bar button.primary").first).to_be_enabled(timeout=30_000)


def capture_matrix(page: Page, output: Path) -> list[str]:
    metrics = []
    for width, height in ((1280, 720), (1920, 1080), (2048, 1024), (980, 760)):
        page.set_viewport_size({"width": width, "height": height})
        search(page, "横纹肌")
        result = page.locator(".result-main").first.bounding_box()
        assert result and result["y"] < height, f"Search results are below the fold at {width}x{height}"
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 2")
        page.screenshot(path=output / f"search-{width}x{height}.png")
        module_button(page, "批量编码").click()
        coding = page.locator(".coding-module")
        expect(coding).to_be_visible()
        box = coding.bounding_box()
        assert box and box["width"] >= width * 0.9, f"Coding workspace does not use full width at {width}x{height}"
        page.screenshot(path=output / f"coding-{width}x{height}.png")
        metrics.append(f"layout {width}x{height}")
    return metrics


def verify_coding(page: Page, output: Path) -> None:
    module_button(page, "批量编码").click()
    picker = page.locator('input[type=file][aria-label="选择 Data Listing 文件"]')
    listing = (
        "\ufeff受试者编号,不良事件名称(AETERM)\n"
        "QA-001,Headache\nQA-002,Headache\nQA-003,ZZZ QA UNMATCHED\n"
    )
    picker.set_input_files({"name": "合成-编码.csv", "mimeType": "text/csv", "buffer": listing.encode("utf-8")})
    row = page.locator(".coding-table tbody tr", has_text="Headache")
    accept = row.get_by_role("button", name="接受", exact=True)
    formal = page.get_by_role("button", name=re.compile("导出正式编码清单"))
    expect(accept).to_be_enabled(timeout=30_000)
    expect(row).to_contain_text(re.compile("待审|待人工确认"))
    expect(formal).to_be_disabled()
    accept.click()
    expect(formal).to_be_enabled()
    with page.expect_download() as event:
        formal.click()
        confirm = page.get_by_role("dialog").get_by_role("button", name=re.compile(r"导出正式清单"))
        if confirm.is_visible():
            confirm.click()
    csv_path = output / "synthetic-coded.csv"
    event.value.save_as(csv_path)
    data = csv_path.read_bytes()
    assert data.startswith(b"\xef\xbb\xbf")
    rows = list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))
    assert [row["受试者编号"] for row in rows] == ["QA-001", "QA-002"]
    assert all(row["PT代码"] and row["LLT代码"] for row in rows)
    assert {row["词典版本"] for row in rows} == {"29.0"}
    assert all(re.fullmatch(r"[0-9a-f]{40}", row["索引签名"]) for row in rows)
    assert [row["来源行"] for row in rows] == ["2", "3"]
    page.wait_for_function("window.__meddraHasUnsavedWork === true")

    with page.expect_download() as event:
        page.get_by_role("button", name=re.compile("导出异常清单")).first.click()
    csv_path = output / "synthetic-exceptions.csv"
    event.value.save_as(csv_path)
    exceptions = list(csv.DictReader(csv_path.open(encoding="utf-8-sig", newline="")))
    assert len(exceptions) == 1 and exceptions[0]["原文术语"] == "ZZZ QA UNMATCHED"
    assert not exceptions[0].get("PT代码") and not exceptions[0].get("LLT代码")
    page.wait_for_function("window.__meddraHasUnsavedWork === false")

    replacement = "\ufeff受试者编号,不良事件名称(AETERM)\nQA-004,Headache\n"
    picker.set_input_files({"name": "合成-新表.csv", "mimeType": "text/csv", "buffer": replacement.encode("utf-8")})
    dialog = page.get_by_role("dialog")
    if dialog.is_visible():
        dialog.get_by_role("button", name=re.compile("继续导入|替换|导入新")).first.click()
    expect(page.get_by_text("合成-新表.csv", exact=False).first).to_be_visible()
    expect(formal).to_be_disabled()
    new_row = page.locator(".coding-table tbody tr", has_text="Headache")
    new_row.get_by_role("button", name="改码", exact=True).click()
    recode = page.get_by_role("dialog")
    field = recode.get_by_role("textbox", name="改码检索")
    field.fill("10019211")
    field.press("Enter")
    recode.locator(".recode-hit", has_text="10019211").first.click()
    recode.get_by_role("textbox", name="改码原因 / 审阅备注").fill("QA manual review")
    recode.get_by_role("button", name="保存改码决定").click()
    expect(new_row).to_contain_text("人工改码")
    expect(formal).to_be_enabled()
    page.get_by_role("button", name="导入 Listing", exact=True).click()
    prompt = page.get_by_role("dialog")
    expect(prompt).to_contain_text("替换当前编码会话")
    prompt.get_by_role("button", name="取消", exact=True).click()
    expect(formal).to_be_enabled()
    page.screenshot(path=output / "coding-review.png")


def run(page: Page, app_url: str = APP_URL, output: Path = OUTPUT) -> list[str]:
    output.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(app_url, wait_until="domcontentloaded")
    expect(page).to_have_title("MedDRA Browser")
    expect(page.locator(".brand h1")).to_have_text("MedDRA Browser")
    versions = page.locator(".version-select")
    expect(versions.get_by_role("option", name=re.compile("29.0"))).to_have_count(1)
    versions.select_option("29.0")
    ready(page, "29.0")

    mode = page.locator(".segmented")
    mode.get_by_role("button", name="英文", exact=True).click()
    search(page, "Rhabdomyolysis")
    expect(page.locator(".result-main").first).to_contain_text("Rhabdomyolysis")
    expect(page.locator(".result-main").first).not_to_contain_text("横纹肌溶解")
    mode.get_by_role("button", name="中文", exact=True).click()
    search(page, "横纹肌溶解")
    expect(page.locator(".result-main").first).to_contain_text("横纹肌溶解")
    expect(page.locator(".result-main").first).not_to_contain_text("Rhabdomyolysis")
    mode.get_by_role("button", name="双语", exact=True).click()
    search(page, "10039020")
    expect(page.locator(".result-main").first).to_contain_text("10039020")
    expect(page.locator(".result-main").first).to_contain_text("Rhabdomyolysis")

    page.locator(".result-actions button").first.click()
    module_button(page, "Research Bin").click()
    with page.expect_download() as event:
        page.get_by_role("button", name="导出JSON").click()
    event.value.save_as(output / "research-bin.json")

    module_button(page, "高级搜索").click()
    fields = page.locator(".advanced-grid input")
    fields.nth(0).fill("renal")
    fields.nth(1).fill("failure")
    page.locator(".advanced-grid button.primary").click()
    expect(page.locator(".result-main").first).to_be_visible()

    module_button(page, "搜索").click()
    page.locator(".level-filter button", has_text="SMQ").click()
    search(page, "横纹肌")
    page.locator(".result-group", has_text="SMQ匹配").locator(".result-main").first.click()
    expect(page.locator(".detail-workspace")).to_be_visible()
    expect(page.locator(".right-pane .relationship-tree-node.current").first).to_be_visible()

    module_button(page, "设置").click()
    expect(page.get_by_role("button", name="选择词典文件夹").first).to_be_visible()
    expect(page.locator(".settings-panel")).not_to_contain_text("/Users/")
    check = capture_matrix(page, output)
    page.set_viewport_size({"width": 1280, "height": 720})
    verify_coding(page, output)
    assert not errors, errors
    return ["language and version switch", "code search", "Research Bin download", "advanced search",
            "SMQ relationships", "settings", *check,
            "coding import, human confirmation, export coverage, new-list isolation and manual recoding"]


def launch_browser(playwright) -> Browser:
    executable = os.environ.get("MEDDRA_QA_CHROMIUM")
    return playwright.chromium.launch(headless=True, executable_path=executable)


def main() -> None:
    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 960}, accept_downloads=True, reduced_motion="reduce")
            print("\n".join(run(page)))
        finally:
            browser.close()


if __name__ == "__main__":
    main()
