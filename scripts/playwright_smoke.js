export default async function runMeddraSmoke(page) {
  const checks = [];
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const ensureVisible = async (name, locator) => {
    await locator.first().waitFor({ state: "visible", timeout: 15000 });
    checks.push(name);
  };

  const ensureNoResultTextOverlap = async (name) => {
    const issues = await page.locator(".center-pane .result").evaluateAll((rows) => {
      const selectors = [
        [".result-main .level-badge", "层级标记"],
        [".result-main strong", "主名称"],
        [".result-main small", "英文名"],
        [".result-main em", "代码"],
        [".result-meta span:nth-child(1)", "匹配类型"],
        [".result-meta span:nth-child(2)", "匹配字段"],
        [".result-meta p", "匹配说明"],
        [".result-actions", "操作区"],
      ];
      const visibleRect = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 1 || rect.height <= 1) {
          return null;
        }
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      const overlaps = [];
      rows.forEach((row, rowIndex) => {
        if (row.scrollWidth > row.clientWidth + 4) {
          overlaps.push({
            row: rowIndex + 1,
            type: "row-overflow",
            width: row.clientWidth,
            scrollWidth: row.scrollWidth,
          });
        }
        const parts = selectors.flatMap(([selector, label]) => {
          return Array.from(row.querySelectorAll(selector)).map((element, partIndex) => {
            const rect = visibleRect(element);
            if (!rect) return null;
            return {
              label: partIndex ? `${label}#${partIndex + 1}` : label,
              text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32),
              rect,
            };
          }).filter(Boolean);
        });
        for (let i = 0; i < parts.length; i += 1) {
          for (let j = i + 1; j < parts.length; j += 1) {
            const a = parts[i];
            const b = parts[j];
            const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            if (overlapX > 2 && overlapY > 2) {
              overlaps.push({
                row: rowIndex + 1,
                type: "text-overlap",
                a: `${a.label}:${a.text}`,
                b: `${b.label}:${b.text}`,
                overlapX: Math.round(overlapX),
                overlapY: Math.round(overlapY),
              });
            }
          }
        }
      });
      return overlaps.slice(0, 6);
    });
    if (issues.length) {
      throw new Error(`${name}存在文字碰撞或横向溢出: ${JSON.stringify(issues)}`);
    }
    checks.push(name);
  };

  const appUrl = typeof process !== "undefined" && process.env.MEDDRA_BROWSER_URL
    ? process.env.MEDDRA_BROWSER_URL
    : "http://127.0.0.1:8765/";
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.removeItem("meddra.bin");
    localStorage.removeItem("meddra.history");
    localStorage.removeItem("meddra.panes");
  });
  await page.reload({ waitUntil: "networkidle" });
  await ensureVisible("中文主导航", page.locator(".module-nav button.active", { hasText: "搜索" }));
  await ensureVisible("品牌Logo", page.locator(".brand img"));
  const logoLoaded = await page.locator(".brand img").evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth >= 64);
  if (!logoLoaded) {
    throw new Error("品牌Logo未正确加载");
  }
  checks.push("品牌Logo加载成功");
  await ensureVisible("SOC层级树", page.getByText("SOC层级"));
  await ensureVisible("版本选择", page.locator(".version-select"));
  await ensureVisible("默认PT搜索层级", page.locator(".level-filter button.active", { hasText: "PT" }));
  await ensureVisible("SMQ搜索层级可选", page.locator(".level-filter button", { hasText: "SMQ" }));
  if (await page.getByRole("button", { name: "代码查询" }).count()) {
    throw new Error("旧代码查询导航仍然存在");
  }
  const versionOptions = await page.locator(".version-select option").allTextContents();
  if (!versionOptions.some((value) => value.includes("MedDRA 29.0"))) {
    throw new Error("版本下拉框未包含MedDRA 29.0测试夹具");
  }
  if (!versionOptions.every((value) => value.includes("双语") || value.includes("仅中文") || value.includes("仅英文"))) {
    throw new Error("版本下拉框未显示语言可用性标签");
  }
  await page.screenshot({ path: "output/playwright/desktop-initial.png", fullPage: true });

  await page.getByRole("button", { name: "英文" }).click();
  await ensureVisible("英文显示模式", page.locator(".segmented button.active", { hasText: "英文" }));
  await page.getByRole("button", { name: "双语" }).click();

  const searchInput = page.getByPlaceholder("可输入AE/MH名称进行模糊查询或输入代码进行精确查询");
  await searchInput.fill("rhabdomyolisys");
  await page.locator(".center-pane .query-bar button.primary").click();
  await ensureVisible("模糊查询分组", page.getByText("模糊候选").first());
  await ensureVisible("模糊候选命中Rhabdomyolysis", page.getByText("Rhabdomyolysis").first());
  await ensureVisible("模糊原因无分数", page.getByText(/近似文本候选/).first());
  const fuzzyMeta = await page.locator(".result.fuzzy .result-meta").first().textContent();
  if (/模糊相似度|\b\d{2,3}(?:\.\d)?\b/.test(fuzzyMeta || "")) {
    throw new Error(`模糊结果仍显示分数: ${fuzzyMeta}`);
  }
  await ensureNoResultTextOverlap("模糊搜索结果无文字碰撞");

  await page.locator(".result-main").first().click();
  await ensureVisible("中心详情关系模块", page.locator(".center-pane .detail-workspace"));
  await ensureVisible("右侧关系树", page.locator(".right-pane .relationship-tree-panel"));
  await ensureVisible("关系树当前节点高亮", page.locator(".right-pane .relationship-tree-node.current", { hasText: "Rhabdomyolysis" }));
  await ensureVisible("关系树父级SOC展开", page.locator(".right-pane .relationship-tree-node", { hasText: "Musculoskeletal" }));
  await ensureVisible("关系树直接子级默认折叠", page.locator(".right-pane .relationship-tree-toggle", { hasText: "直接子级" }));
  await ensureVisible("父系路径默认展开", page.getByText("父系层级路径"));
  await ensureVisible("术语详情SMQ关系", page.getByText("SMQ成员关系"));
  await page.locator(".right-pane .relationship-tree-toggle", { hasText: "直接子级" }).first().click();
  await ensureVisible("关系树子级可展开", page.locator(".right-pane .relationship-tree-children .relationship-tree-node", { hasText: "LLT" }).first());
  await page.screenshot({ path: "output/playwright/v3-detail-tree.png", fullPage: true });
  await page.locator(".module-nav button", { hasText: /^搜索$/ }).click();
  await page.locator('.result-actions button[title="加入Research Bin"]').first().click();
  await ensureVisible("Research Bin已加入状态", page.getByText("已加入").first());

  await page.locator(".module-nav button", { hasText: /^搜索$/ }).click();
  await searchInput.fill("10039020");
  await page.locator(".center-pane .query-bar button.primary").click();
  await ensureVisible("主搜索框代码查询分组", page.locator(".result-group", { hasText: "代码匹配" }));
  await ensureVisible("主搜索框代码查询结果", page.getByText("横纹肌溶解").first());
  await ensureNoResultTextOverlap("代码搜索结果无文字碰撞");

  const leftBefore = await page.locator(".left-pane").boundingBox();
  const leftResizer = await page.locator(".pane-resizer-left").boundingBox();
  if (!leftBefore || !leftResizer) throw new Error("未找到左侧拖拽栏");
  await page.mouse.move(leftResizer.x + leftResizer.width / 2, leftResizer.y + 60);
  await page.mouse.down();
  await page.mouse.move(leftResizer.x + 84, leftResizer.y + 60, { steps: 8 });
  await page.mouse.up();
  const leftAfter = await page.locator(".left-pane").boundingBox();
  if (!leftAfter || leftAfter.width <= leftBefore.width + 36) {
    throw new Error(`左侧栏拖拽未改变宽度: before=${leftBefore?.width} after=${leftAfter?.width}`);
  }
  checks.push("三栏左侧宽度可拖拽调整");
  const rightBefore = await page.locator(".right-pane").boundingBox();
  const rightResizer = await page.locator(".pane-resizer-right").boundingBox();
  if (!rightBefore || !rightResizer) throw new Error("未找到右侧拖拽栏");
  await page.mouse.move(rightResizer.x + rightResizer.width / 2, rightResizer.y + 60);
  await page.mouse.down();
  await page.mouse.move(rightResizer.x - 84, rightResizer.y + 60, { steps: 8 });
  await page.mouse.up();
  const rightAfter = await page.locator(".right-pane").boundingBox();
  if (!rightAfter || rightAfter.width <= rightBefore.width + 36) {
    throw new Error(`右侧栏拖拽未改变宽度: before=${rightBefore?.width} after=${rightAfter?.width}`);
  }
  checks.push("三栏右侧宽度可拖拽调整");
  const primaryButtonBox = await page.locator(".center-pane .query-bar button.primary").boundingBox();
  if (!primaryButtonBox || primaryButtonBox.height > 52) {
    throw new Error(`窄中栏搜索按钮疑似被挤成竖排: height=${primaryButtonBox?.height}`);
  }
  const navHasHorizontalOverflow = await page.locator(".module-nav").evaluate((node) => node.scrollWidth > node.clientWidth + 2);
  if (navHasHorizontalOverflow) {
    throw new Error("窄中栏模块导航存在横向溢出或按钮被截断");
  }
  checks.push("窄中栏按钮换行不竖排");
  await searchInput.fill("横纹肌");
  await page.locator(".center-pane .query-bar button.primary").click();
  await ensureVisible("窄中栏包含匹配结果", page.locator(".result-group", { hasText: "包含匹配" }));
  await ensureNoResultTextOverlap("窄中栏搜索结果无文字碰撞");
  await page.screenshot({ path: "output/playwright/final-narrow-search-results.png", fullPage: true });

  await page.getByRole("button", { name: "高级搜索" }).click();
  const advancedInputs = page.locator('input[placeholder="可输入AE/MH名称、中文/英文片段或代码"]');
  await advancedInputs.nth(0).fill("renal");
  await advancedInputs.nth(1).fill("failure");
  await page.locator(".advanced-grid button.primary").click();
  await ensureVisible("高级搜索结果", page.locator(".result-list .result").first());
  await ensureNoResultTextOverlap("高级搜索结果无文字碰撞");

  await page.locator(".module-nav button", { hasText: /^搜索$/ }).click();
  await page.locator(".level-filter button", { hasText: "SMQ" }).click();
  await searchInput.fill("横纹肌");
  await page.locator(".center-pane .query-bar button.primary").click();
  await ensureVisible("统一搜索SMQ结果", page.locator(".result-group", { hasText: "SMQ匹配" }));
  await ensureNoResultTextOverlap("SMQ搜索结果无文字碰撞");
  await page.locator(".result-group", { hasText: "SMQ匹配" }).locator(".result-main").first().click();
  await ensureVisible("SMQ详情中心展示", page.locator(".center-pane .detail-workspace", { hasText: "SMQ" }));
  await ensureVisible("SMQ关系树当前节点", page.locator(".right-pane .relationship-tree-node.current", { hasText: "横纹肌溶解/肌病" }));
  await ensureVisible("SMQ内容默认折叠", page.locator(".right-pane .relationship-tree-toggle", { hasText: "包含术语" }));
  await page.locator(".right-pane .relationship-tree-toggle", { hasText: "包含术语" }).first().click();
  await ensureVisible("SMQ广义狭义显示", page.getByText(/狭义|广义/).first());
  await page.screenshot({ path: "output/playwright/v3-smq-tree.png", fullPage: true });
  const smqDownload = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /导出SMQ/ }).click(),
  ]);
  await smqDownload[0].saveAs("output/playwright/smq-export.csv");

  await page.locator(".module-nav button", { hasText: "Research Bin" }).click();
  await ensureVisible("Research Bin列表", page.locator(".result-list .result").first());
  await ensureVisible("Research Bin移除按钮", page.getByRole("button", { name: /移除/ }).first());
  await ensureNoResultTextOverlap("Research Bin结果无文字碰撞");
  const binDownload = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /导出JSON/ }).click(),
  ]);
  await binDownload[0].saveAs("output/playwright/research-bin.json");

  await page.getByRole("button", { name: "设置" }).click();
  await ensureVisible("词典来源导入", page.getByText("词典来源导入"));
  await ensureVisible("导入文件提示", page.getByText("mdhier.asc"));
  const synonymResponse = page.waitForResponse((response) => response.url().includes("/api/synonyms") && response.ok());
  await page.getByRole("button", { name: "查看中文同义词表" }).click();
  await synonymResponse;
  await ensureVisible("同义词表状态", page.locator(".synonym-status"));

  await page.setViewportSize({ width: 390, height: 820 });
  await page.screenshot({ path: "output/playwright/desktop-narrow-settings.png", fullPage: true });
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  if (bodyWidth > viewportWidth + 4) {
    throw new Error(`窄屏存在页面级横向溢出: body=${bodyWidth}, viewport=${viewportWidth}`);
  }
  checks.push("桌面窄窗口无页面级横向溢出");

  if (consoleErrors.length) {
    throw new Error(`浏览器console错误: ${consoleErrors.join(" | ")}`);
  }
  return { checks, downloads: ["output/playwright/smq-export.csv", "output/playwright/research-bin.json"] };
}
