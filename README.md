# MedDRA Browser Mac

![MedDRA Browser logo](frontend/public/brand/app-icon-256.png)

中文界面的本地 MedDRA Browser，支持 macOS 本地 App 包装、Web 本地服务运行，以及 Windows 便携包运行。项目目标是让医学经理、医学监查员、数据管理员、医学编码员和药物警戒医生在本机完成 MedDRA 术语查询、层级关系浏览、SMQ 检索和 Research Bin 汇总。

> 许可说明：本仓库采用个人非商业许可。它是 source-available 项目，不是 OSI 意义上的开源项目。MedDRA 词典数据受 MedDRA/MSSO/ICH 相关授权约束，本项目不包含、也不授予任何 MedDRA 数据使用权。

## 目录

- [核心特性](#核心特性)
- [系统架构](#系统架构)
- [运行前准备](#运行前准备)
- [数据与版本](#数据与版本)
- [macOS 使用方式](#macos-使用方式)
- [Windows 便携包](#windows-便携包)
- [开发环境](#开发环境)
- [搜索逻辑](#搜索逻辑)
- [视觉与交互](#视觉与交互)
- [测试与验证](#测试与验证)
- [打包发布](#打包发布)
- [许可与合规](#许可与合规)
- [English Documentation](#english-documentation)

## 核心特性

- 中文界面，支持中文、英文、双语显示模式。
- 自动发现本地 MedDRA ASCII 版本，不把 `29.0` 写死为唯一版本。
- 支持英文、中文或双语词典；只有单语言数据时仍可导入和浏览。
- 术语层级覆盖 `SOC / HLGT / HLT / PT / LLT`。
- SMQ 层级与 SMQ 内容浏览，显示广义/狭义范围。
- 统一搜索框：输入数字自动走代码查询，输入文本走术语查询。
- 搜索层级可多选，默认仅搜索 `PT`。
- 支持完全匹配、词序变体、同义词扩展、包含匹配、前缀/后缀匹配、代码匹配和模糊候选。
- 点击术语后显示父系默认展开、子系默认折叠的关系树。
- 支持多 SOC / 多上位路径展示，避免只显示主 SOC。
- Research Bin 支持加入状态、移除、JSON 导出。
- 支持 SMQ 内容导出、搜索结果 CSV 导出。
- 支持三栏拖拽调宽。
- macOS `.app` 本地包装和 Windows 本地便携包。

## 系统架构

项目由三部分组成：

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vite + React + TypeScript | 中文界面、搜索、层级树、关系详情、Research Bin 和设置页 |
| 后端 | FastAPI | 本地 API、数据导入、搜索、导出、静态前端托管 |
| 数据缓存 | SQLite + FTS5 | 从本地 MedDRA ASCII 文件构建索引，缓存到 `backend/data/` |

所有数据处理都在本机完成。项目不会上传 MedDRA 词典、搜索词或导出结果。

## 运行前准备

普通使用者需要：

- 已授权取得的 MedDRA ASCII 词典文件夹。
- Python 3.10 或更新版本，用于启动本地 FastAPI 服务。
- macOS App 发布包已内置后端 Python 依赖，但仍需要系统能运行 `python3`；从源码构建 App 时会绑定当前机器的 `python3` 小版本。
- Windows 便携包首次运行时需要联网安装后端依赖；依赖清单见 `backend/requirements.txt`。

开发者额外需要：

- Node.js 18 或更新版本，用于 Vite/React 前端开发与构建。
- npm，用于安装前端依赖。
- Python Playwright，用于浏览器 smoke 测试：

```bash
python3 -m pip install playwright
python3 -m playwright install chromium
```

## 数据与版本

后端会扫描数据源目录，寻找包含这些 ASCII 文件的 MedDRA 发行目录：

```text
soc.asc
hlgt.asc
hlt.asc
pt.asc
llt.asc
mdhier.asc
hlt_pt.asc
hlgt_hlt.asc
soc_hlgt.asc
smq_list.asc
smq_content.asc
```

可选文件：

```text
intl_ord.asc
```

默认数据源优先级：

1. 环境变量 `MEDDRA_SOURCE_ROOT`。
2. App/便携包内的 `dictionaries/`，仅在其中实际包含 MedDRA ASCII 文件时启用。
3. 项目上级 MedDRA 工作目录。
4. macOS App 启动器还会自动尝试 `~/Documents/指导原则及临床试验规范合集/MedDRA` 和 `~/Documents/MedDRA`。

同义词表默认从以下位置发现：

1. 环境变量 `MEDDRA_SYNONYM_ROOT`。
2. `dictionaries/MDB41_D241_B123/`。
3. 数据源目录附近的 `MDB41_D241_B123/`。

SQLite 缓存按版本写入 `backend/data/`，例如：

```text
backend/data/meddra_29_0.sqlite
backend/data/meddra_28_2_en_<hash>.sqlite
```

缓存文件、WAL/SHM 文件和原始 MedDRA 数据均不会提交到 GitHub。

## macOS 使用方式

### 方式一：安装自包含 App

从 GitHub Release 下载 `meddra-browser-mac-app.zip`，解压后将 App 拖入：

```text
/Applications/MedDRA Browser Mac.app
```

双击 App 后会启动本地 FastAPI 服务，并打开：

```text
http://127.0.0.1:8765/
```

这是未签名、未 notarized 的本地 App。首次打开如果被 macOS 拦截，可在 Finder 中右键 App，选择“打开”。

运行时文件位置：

```text
~/Library/Application Support/MedDRA Browser Mac/data
~/Library/Application Support/MedDRA Browser Mac/dictionaries
~/Library/Logs/MedDRA Browser Mac/server.log
```

### 方式二：从源码生成并安装 App

```bash
./scripts/build_macos_app.sh "/Applications/MedDRA Browser Mac.app"
```

该 App 会把前端、后端和当前 `python3` 对应的后端依赖一起打包，因此移动到 `/Applications` 后不再依赖仓库目录。若在另一台 Mac 上运行时提示 Python 小版本不一致，请在目标机器上重新执行上述构建命令。

### 方式三：命令行启动

```bash
./scripts/start_meddra_server.sh
open http://127.0.0.1:8765/
```

如果字典不在项目上级目录，可显式指定：

```bash
export MEDDRA_SOURCE_ROOT="/path/to/MedDRA"
./scripts/start_meddra_server.sh
```

## Windows 便携包

浏览器安全模型不允许直接打开 `file://index.html` 后自动启动 Python 后端，也不允许网页直接读取任意本地 MedDRA 文件夹。因此 Windows 版采用“同文件夹本地服务”方式：

1. 解压 `meddra-browser-portable.zip`。
2. 将授权获得的 MedDRA ASCII 目录放入：

```text
meddra-browser-portable/dictionaries/
```

3. 双击：

```text
start_windows.bat
```

4. 浏览器会打开：

```text
http://127.0.0.1:8765/
```

首次运行会创建 `.venv_windows` 并安装后端依赖。运行过程中请保持命令窗口打开。

便携包内也提供 `index.html`。它会检测本地服务是否已经启动；如果未启动，会提示先运行 `start_windows.bat`。

## 开发环境

### 后端

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
PYTHONPATH=backend python3 -m uvicorn app.main:app --reload --port 8765
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

开发模式打开：

```text
http://127.0.0.1:5173/
```

生产构建：

```bash
cd frontend
npm run build
```

生产构建后由 FastAPI 直接托管 `frontend/dist`。

## 搜索逻辑

统一搜索框会先判断输入：

- 全数字输入：按 MedDRA code 查询。
- 文本输入：按术语搜索。

术语搜索包括：

- `exact`：完全匹配。
- `lexical`：词序或标点变体。
- `synonym`：同义词扩展。
- `contains`：包含匹配。
- `prefix_suffix`：开头或结尾匹配。
- `fuzzy`：拼写或近似文本候选。
- `smq`：SMQ 名称与内容匹配。

模糊候选不会在界面显示分数。排序逻辑为：相关性优先，同分时按代码数字升序排列。

## 视觉与交互

- 左侧：SOC/SMQ 层级树。
- 中央：搜索、高级搜索、详情、Research Bin、历史、设置。
- 右侧：当前术语或 SMQ 的关系树。
- 三栏宽度可拖拽调整。
- 在窄中栏状态下，按钮和结果行自动换行，避免文字互相压住。
- Logo 使用生成图标，表现数据库、医学标记、层级树和搜索。

## 测试与验证

后端测试：

```bash
PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v
```

前端构建：

```bash
cd frontend
npm run build
```

Playwright smoke 脚本：

```bash
python3 scripts/playwright_smoke.py
```

当前 smoke 覆盖：

- 中文主导航。
- 版本选择。
- 默认 PT 搜索层级。
- 模糊查询。
- 代码查询。
- 详情关系树。
- 三栏拖拽调宽。
- 窄中栏无文字碰撞。
- 高级搜索。
- SMQ 搜索与导出。
- Research Bin 加入、移除和导出。
- 设置页导入提示。
- 窄屏无页面级横向溢出。

## 打包发布

生成 Windows 便携 zip：

```bash
./scripts/build_portable_package.sh
```

输出：

```text
build/meddra-browser-portable.zip
```

生成 macOS App：

```bash
./scripts/build_macos_app.sh
ditto -c -k --sequesterRsrc --keepParent "build/MedDRA Browser Mac.app" build/meddra-browser-mac-app.zip
```

该 zip 不包含 MedDRA 原始词典数据。

## 许可与合规

本项目代码使用 `MedDRA Browser Personal Non-Commercial License v1.0`。详见 [LICENSE.md](LICENSE.md)。

重点限制：

- 仅允许个人非商业使用。
- 不允许商业使用、销售、SaaS 托管或企业内部生产使用。
- 不包含 MedDRA 数据授权。
- 不提供医学、监管、编码或药物警戒结论保证。

本项目不是 MedDRA 官方软件，也不代表 ICH、MSSO 或任何 MedDRA 官方机构。

---

# English Documentation

## Overview

MedDRA Browser Mac is a local Chinese-interface MedDRA browser with macOS wrapper support and a Windows portable local-service package. It is designed for local terminology lookup, hierarchy review, SMQ browsing, and Research Bin workflows.

This repository is source-available under a personal non-commercial license. It is not OSI open source. MedDRA dictionary data is licensed separately and is not included.

## Features

- Chinese UI with Chinese, English, and bilingual display modes.
- Local MedDRA ASCII discovery without hard-coding one release.
- Supports English-only, Chinese-only, and bilingual releases.
- SOC, HLGT, HLT, PT, LLT hierarchy browsing.
- SMQ hierarchy and broad/narrow content browsing.
- Unified search box for term and code queries.
- Multi-select search levels, defaulting to PT.
- Exact, lexical, synonym, contains, prefix/suffix, code, fuzzy, and SMQ search groups.
- Parent-expanded and child-collapsed relationship tree.
- Multiple hierarchy paths and SOC relationships.
- Research Bin add/remove/export.
- CSV/JSON export.
- Resizable three-pane layout.
- macOS local app wrapper and Windows portable local service package.

## Architecture

| Layer | Stack | Purpose |
|---|---|---|
| Frontend | Vite + React + TypeScript | UI, search workflow, hierarchy trees, detail views |
| Backend | FastAPI | Local API, indexing, export, static frontend serving |
| Data cache | SQLite + FTS5 | Local MedDRA ASCII index |

All data stays local.

## Prerequisites

End users need:

- Licensed MedDRA ASCII dictionary folders.
- Python 3.10 or later to run the local FastAPI service.
- The macOS app bundle vendors backend Python dependencies, but still requires a working system `python3`; source-built app bundles are tied to the builder machine's `python3` minor version.
- Internet access on first Windows portable launch to install backend dependencies from `backend/requirements.txt`.

Developers also need:

- Node.js 18 or later for Vite/React development and builds.
- npm for frontend dependency installation.
- Python Playwright for browser smoke tests:

```bash
python3 -m pip install playwright
python3 -m playwright install chromium
```

## Data

Set `MEDDRA_SOURCE_ROOT` to the folder containing licensed MedDRA ASCII releases, or place releases in the portable `dictionaries/` folder.

The app only treats a bundled `dictionaries/` folder as a source when it actually contains MedDRA ASCII files. On macOS, the app launcher also checks `~/Documents/指导原则及临床试验规范合集/MedDRA` and `~/Documents/MedDRA`.

Required files include `soc.asc`, `pt.asc`, `llt.asc`, `mdhier.asc`, `smq_list.asc`, and `smq_content.asc` plus the relationship files listed in the Chinese section above.

MedDRA source files and SQLite caches are intentionally excluded from GitHub.

## Run On macOS

Download `meddra-browser-mac-app.zip` from a release, unzip it, and move the app to:

```text
/Applications/MedDRA Browser Mac.app
```

Then double-click it. If macOS blocks the unsigned app, use Finder right-click and choose Open.

To build the movable app from source:

```bash
./scripts/build_macos_app.sh "/Applications/MedDRA Browser Mac.app"
```

The app writes runtime data and logs under:

```text
~/Library/Application Support/MedDRA Browser Mac/
~/Library/Logs/MedDRA Browser Mac/server.log
```

Command-line local service mode:

```bash
./scripts/start_meddra_server.sh
open http://127.0.0.1:8765/
```

## Run On Windows

Use the portable zip generated by:

```bash
./scripts/build_portable_package.sh
```

After unzipping on Windows:

1. Place licensed MedDRA ASCII folders under `dictionaries/`, or set `MEDDRA_SOURCE_ROOT`.
2. Double-click `start_windows.bat`.
3. Open `http://127.0.0.1:8765/`.

Opening `index.html` directly cannot start the backend because of browser security restrictions. The HTML launcher only detects an already running local server and explains how to start it.

## Development

Backend:

```bash
PYTHONPATH=backend python3 -m uvicorn app.main:app --reload --port 8765
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Build:

```bash
cd frontend
npm run build
```

Tests:

```bash
PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v
python3 scripts/playwright_smoke.py
```

## License

See [LICENSE.md](LICENSE.md). Personal non-commercial use only. MedDRA data rights are not included.
