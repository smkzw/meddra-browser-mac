# MDB功能覆盖矩阵

日期：2026-07-02

## 来源

- MedDRA官网 Browsers 页面：`https://www.meddra.org/browsers`
- MDB 4.1 Online User Guide：`https://mssotools.com/mssoweb/mdb/000343%20MDB4%20User%20Guide_4_1/content.htm`
- MDB 5.0 User Guide：`https://mssotools.com/mssoweb/mdb/mdb5_index.pdf`，仅用于交叉核对多版本/导入模式；本项目当前以MDB 4.1功能覆盖为主。

## 覆盖状态

| MDB功能/交互 | 当前实现 | 验证方式 |
|---|---|---|
| 本地载入MedDRA文件 | 后端扫描本地MedDRA目录，自动发现完整中英文版本，SQLite缓存按版本命名 | `test_release_discovery_keeps_29_0_as_test_fixture_not_hardcoded_default`、`test_status_and_version_discovery` |
| 版本选择 | 顶部“MedDRA版本”下拉框；默认最新完整中英文版本，29.0仅为测试夹具 | API状态测试、Playwright版本下拉检查 |
| 中文界面 | 所有应用导航、按钮、提示和功能区为中文 | Playwright中文标签检查 |
| 英文/中文/双语显示和搜索 | 顶部中文/英文/双语切换，API按mode筛选字段 | 后端搜索测试、Playwright模式切换 |
| SOC层级浏览 | 左侧SOC树，按`intl_ord.asc`官方顺序展示，可逐级展开 | `test_tree_and_analysis_endpoints_data`、Playwright树展开 |
| SMQ层级浏览 | 左侧SMQ树，SMQ详情区展示子SMQ和内容术语 | `test_smq_search_details_and_export_support`、Playwright SMQ打开 |
| 术语搜索结果分组 | 完全匹配、词序变体、同义词扩展、包含、开头/结尾、代码、模糊候选 | `test_search_categories_code_and_soc_filter`、`test_fuzzy_search_is_labeled_and_scores_typo` |
| 代码查询 | 独立“代码查询”模块和通用搜索代码匹配 | `test_search_categories_code_and_soc_filter`、Playwright代码查询 |
| SOC过滤 | 搜索模块SOC下拉过滤 | `test_search_categories_code_and_soc_filter`、Playwright搜索过滤 |
| Go to Browser/打开详情 | 搜索结果、代码结果、树节点均可打开右侧详情 | `test_browse_details_analysis_and_copy_source_fields`、Playwright结果打开 |
| 详情/出现位置 | 右侧详情显示主SOC/次SOC、HLGT、HLT、PT出现路径 | `test_golden_terms_have_bilingual_names_and_hierarchy`、Playwright详情检查 |
| Hierarchy Analysis | API返回术语所有层级出现路径；前端详情区直接展示 | `test_browse_details_analysis_and_copy_source_fields` |
| SMQ搜索 | 右侧SMQ搜索，支持SMQ名称、SMQ代码和SMQ内容术语代码 | `test_smq_search_details_and_export_support`、Playwright SMQ搜索 |
| SMQ Analysis | API返回术语的SMQ成员关系；前端详情区展示广义/狭义和状态 | `test_browse_details_analysis_and_copy_source_fields` |
| SMQ广义/狭义和非活动状态 | `smq_content.asc` scope 1/2映射为广义/狭义，状态显示有效/非活动 | `test_smq_scope_examples`、SMQ详情测试 |
| SMQ导出 | SMQ详情区导出CSV，包含scope/status字段 | `test_smq_search_details_and_export_support`、Playwright下载检查 |
| 高级搜索 | 两个查询字段；包含、开头为、完全等于、结尾为；AND/OR/NOT | `test_advanced_search_boolean`、`test_advanced_search_boolean_variants` |
| 同义词列表和开关 | 搜索选项可启用/关闭同义词；设置页可预览中/英文同义词表 | `test_synonym_list_endpoint`、Playwright设置页检查 |
| 忽略变音符号 | 搜索选项“忽略变音符号”，后端normalize支持unicode去除变音符号 | 搜索API测试覆盖，Playwright选项检查 |
| 清除/取消 | 搜索模块提供“清除”和“取消”按钮；取消使用AbortController | Playwright交互检查 |
| VCR/历史导航 | 历史记录模块保留操作记录，搜索区提供上一条/下一条搜索导航 | Playwright历史检查 |
| 复制术语/复制代码 | 详情区提供复制代码、复制术语按钮 | Playwright按钮可见性检查 |
| Research Bin | 搜索结果加入、移除、清空，支持JSON/CSV导出和导入 | Playwright端到端导出检查 |
| 导出搜索结果 | 搜索结果导出CSV | Playwright下载检查 |
| 模糊查询说明 | 模糊结果独立分组，显示分数、匹配字段和建议原因 | `test_fuzzy_search_is_labeled_and_scores_typo`、Playwright模糊查询 |

## 当前验收边界

- Mac App打包尚未开始；按计划在Web版验收后再做。
- v1不含RAG/LLM建议功能；所有搜索结果来自本地词典、同义词表和确定性算法。
- 当前自动计数断言只针对MedDRA 29.0本地测试夹具；新版本导入后应新增对应版本的计数夹具或验收记录。
