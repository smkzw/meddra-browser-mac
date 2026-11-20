"""Verify the installed portable program and its optional file:// entry."""

from __future__ import annotations

import argparse
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright

from playwright_smoke import APP_URL, launch_browser, run


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=APP_URL)
    parser.add_argument("--html", type=Path)
    parser.add_argument("--skip-ui", action="store_true")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 960}, accept_downloads=True)
            base_url = args.url.rstrip("/") + "/"
            runtime = page.request.get(base_url + "api/runtime-info").json()
            assert runtime["distribution_mode"] == "portable" and runtime["shutdown_available"]
            assert len(runtime["instance_id"]) == 32
            if args.html:
                page.goto(args.html.resolve().as_uri(), wait_until="domcontentloaded")
                page.wait_for_url(base_url, timeout=15_000)
                print("file:// entry opened this portable session")
            if not args.skip_ui:
                print("\n".join(run(page, base_url)))
                page.get_by_role("button", name="退出便携版", exact=True).click()
                page.get_by_role("dialog").get_by_role("button", name=re.compile(r"^(确认|仍要)退出便携版$")).click()
                expect(page.get_by_text("服务已停止", exact=False).first).to_be_visible()
                if args.html:
                    page.goto(args.html.resolve().as_uri())
                    expect(page.get_by_text("尚无可用地址", exact=False)).to_be_visible()
                print("Portable workbench stopped and entry recovered")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
