# MedDRA Browser Portable 0.1.12 — Grok software-engineer release-gate audit

Date: 2026-08-14  
Role: independent software engineer (Grok Build / grok-4.6)  
Worktree: `/Users/smkzw/Documents/指导原则及临床试验规范合集/MedDRA/qa-worktrees/grok`  
Branch: `qa/meddra-portable-grok`  
Baseline commit audited: `52a0de004333196161561a554768f62c2afcdd3a` (`Fix portable browser entry discovery`)  
Candidate version in source: `0.1.12` (`backend/app/main.py`)  
Consecutive-clean result: **2 consecutive clean rounds after fixes (Round 1 source + Round 2 fresh packaged extract). No open P0–P4 in the tested Mac/source/packaged-runtime scope.**  
Recommendation: **ship the patched 0.1.12 portable candidate for Mac/source verification; do not claim a native Windows pass.**

`AGENTS.md` was not present in this worktree or the parent MedDRA repo. The task’s hard boundaries were followed instead.

---

## 1. Sources read

Required files only, then additional implementation files needed to reproduce and patch:

- `README.md`
- `portable-index.html`
- `scripts/run_portable_server.py`
- `start_windows.bat`
- `backend/app/main.py`
- `frontend/src/App.tsx`
- `backend/tests/test_api_manual_coverage.py`
- Also inspected: `backend/app/meddra_data.py`, `scripts/build_portable_package.sh`, `scripts/start_meddra_server.sh`, `scripts/playwright_smoke.py`, `backend/tests/test_meddra_data.py`, `frontend/package.json`, `frontend/index.html`
- Candidate artifact: `/Users/smkzw/Documents/指导原则及临床试验规范合集/MedDRA/meddra-browser-mac/build/meddra-browser-portable.zip` (34,170,464 bytes, built 2026-08-14 16:19)

Not modified: main worktree, user Application Support, raw MedDRA ASCII files, other QA worktrees, GitHub, remotes.

---

## 2. Commands and environment

Host: macOS 26.5.1 (Darwin 25.5.0, arm64). Python 3.9.6 (`/usr/bin/python3`). Node v22.22.3.

Dedicated runtime (never reused the user’s Mac app state):

```text
MEDDRA_BROWSER_HOST=127.0.0.1
MEDDRA_BROWSER_PORT=8861
MEDDRA_BROWSER_OPEN=0
MEDDRA_BROWSER_STATE_DIR=<worktree>/.qa-state          # round 1 source
MEDDRA_BROWSER_STATE_DIR=<worktree>/.qa-state/round2    # round 2 extract
MEDDRA_SOURCE_ROOT=/Users/smkzw/Documents/指导原则及临床试验规范合集/MedDRA
MEDDRA_APP_STORE_MODE=0
MEDDRA_DISTRIBUTION_MODE=portable
```

Worktree venv: `.venv` (FastAPI 0.128.8 + uvicorn + httpx + playwright). Playwright Chromium from `~/Library/Caches/ms-playwright`.

Left intact (not killed):

- `127.0.0.1:8765` — `/Applications/MedDRA Browser Mac.app` , `version=0.1.11`, `distribution_mode=free_mac`
- `*:8768` — unrelated `python -m http.server 8768` (PID 83524)

---

## 3. Package / runtime paths

| Item | Path |
| --- | --- |
| Baseline source | this worktree at `52a0de0` |
| Independent extract of original candidate | `.qa-extract/meddra-browser-portable` |
| Rebuilt patched zip | `build/meddra-browser-portable.zip` (34,172,870 bytes) |
| Round 2 fresh extract | `.qa-extract/round2/meddra-browser-portable` |
| Isolated indexes | `.qa-state/meddra_29_0.sqlite` (109 MB), `.qa-state/round2/…` |
| Unit-test indexes | `.qa-state/unittest/` |
| Logs | `logs/qa/source-8861.log`, `logs/qa/round2-8861.log` |
| UI screenshots / exports | `output/playwright/` |

Original candidate zip: Chinese launcher names already had ZIP UTF-8 bit 11 set; ASCII names did not. `ditto -x -k` restored `【Windows】第一步：请双击我运行.bat`, `第二步：双击我开始MedDRA浏览.html`, and `请先看我.txt` correctly on macOS.

---

## 4. Assumptions and likely failure modes (pre-test)

1. Windows `file://` step 2 cannot fetch `http://127.0.0.1` (Private Network Access / Edge-Chrome local-network policy). JSONP may also be blocked. The page then loops on “还没有检测到便携版服务”.
2. Default HTML scan is only `8765–8784`. A dedicated/fallback port such as `8861` is invisible to step 2 unless `?port=` is present.
3. Port `8765` on this machine is already a **different MedDRA identity** (`free_mac` 0.1.11). Portable must not reuse it.
4. Selecting a parent folder that contains `qa-worktrees/**/node_modules` can make `Path.rglob("soc.asc")` look like runaway indexing.
5. App Store / Mac.app wording can leak into portable Windows settings errors.
6. Native Windows `.bat`, silent Python installer, and Explorer unzip were **not executable here**.

---

## 5. Round-by-round test matrix

### Round 1 — baseline then patched source (port 8861, 8765 occupied)

| Area | Result | Evidence |
| --- | --- | --- |
| Inspect source / zip / launchers | Done | files listed above; zip listing; runtime-info on 8765 |
| Occupy 8765 with another MedDRA identity | Pass (pre-existing) | `free_mac` 0.1.11 left running |
| Occupy 8768 with unrelated HTTP | Pass (pre-existing) | `python -m http.server` 404 on `/api/runtime-info` |
| Dedicated port 8861 portable identity | Pass after start | `{"version":"0.1.12","app_store_mode":false,"distribution_mode":"portable"}` |
| file:// step 2 **without** sidecar, service on 8861 | **Reproduced P1** | stayed on helper: “还没有检测到便携版服务…” |
| file:// step 2 **with** sidecar | Pass after fix | navigated to `http://127.0.0.1:8861/` |
| file:// `?port=8861` JSONP/fetch on Mac Chromium | Pass | navigated; this does **not** prove Windows PNA |
| select_port skips non-portable / unknown | Pass | `test_select_port_skips_non_portable_and_unknown_identities` |
| PNA preflight header | Fail baseline / pass after fix | `test_runtime_info_allows_private_network_preflight` |
| Dictionary walk skips `node_modules` / `qa-worktrees` | Fail baseline / pass after fix | unit test + workspace parent import 0.011 s |
| Workspace parent import | Pass after fix | `POST /api/source-roots` of MedDRA root returned in 11 ms, versions 29.0/28.2/28.1/28.0 |
| Invalid / missing / non-dict folder | Pass | 400 “目录不存在或不存在或不可读取” / “未在所选文件夹…发现” |
| Duplicate folder add | Pass | second add did not grow unique roots beyond env + one added path |
| Folder picker cancel | Pass | unit test `status=cancelled` |
| Index 29.0 then 28.0 once | Pass | 28.0 ready in one pass; 29.0 stayed ready; no extra sqlite growth loop |
| Main search / exact code / fuzzy / contains | Pass | UI + API tests (Rhabdomyolysis / 10039020 / 横纹肌) |
| Advanced AND/OR/NOT | Pass | UI + `test_advanced_search_boolean*` |
| PT/LLT/HLT/HLGT/SOC/SMQ filters | Pass | UI toggles + SMQ 20000002 |
| SOC/SMQ tree, details, relationship panel | Pass | UI + API details/tree/analysis |
| Synonym / non-current toggles | Pass | UI + settings synonym preview |
| Research Bin add/remove/clear/export/import | Pass | UI + JSON/CSV download; empty clear disabled |
| History | Pass | list + click-to-re-search |
| Settings / manual path / empty path | Pass | 400 + “请先输入…” toast path |
| Export search | Pass | `output/playwright/qa-search-export.csv` |
| Mobile gate | Pass | “建议使用电脑端打开” |
| Header / settings Mac.app branding | Pass after copy fix | no Mac.app in portable UI |
| App Store sandbox identity | Pass | portable `app_store_mode=false`; 8765 not reused |
| API suite | Pass | 12/12 `test_api_manual_coverage.py` in 12.0 s |
| Data suite | Pass | 19/19 `test_meddra_data.py` in 22.9 s |
| Portable discovery suite | Fail baseline 5F+1E / pass after fix 8/8 | `round1-*-portable-tests.txt` |
| Native Windows double-click / installer / Explorer | **UNVERIFIED_PLATFORM** | host is macOS |

Round 1 after patches: **clean** in tested scope.

### Round 2 — fresh restart + rebuilt zip extract

Stopped PID 21609. Extracted `build/meddra-browser-portable.zip` to `.qa-extract/round2/`. Started extract’s `scripts/run_portable_server.py` on 8861 with a **new** `.qa-state/round2`. Index rebuilt once (691,778 rows) and went `ready`. Sidecar written beside the packaged HTML.

| Area | Result |
| --- | --- |
| Packaged runtime-info portable 0.1.12, not App Store | Pass |
| file:// packaged step 2 + sidecar → `http://127.0.0.1:8861/` | Pass |
| file:// copy **without** sidecar still waits (8861 outside 8765–8784) | Pass (expected; real step 2 sits next to sidecar) |
| Full UI control matrix (same 19 checks as Round 1) | Pass (`round2-ui.txt`) |
| Extra: search export, history replay, bin import, mobile gate | Pass |
| 39 unit tests | Pass in 34.5 s (`round2-unit.txt`) |
| 8765 still `free_mac` 0.1.11; 8768 still http.server | Pass |
| No second index storm / process idle after ready | Pass |

Round 2: **clean**. Consecutive-clean counter = **2**.

---

## 6. Issues

### P1 — Step 2 `file://` page cannot find a portable service on a non-default / fallback port

- **Platform:** Windows reported; reproduced on macOS when the service listens on 8861 (outside `8765–8784`) or when the helper is opened without a same-folder sidecar.
- **Reproduction:** Start portable on 8861 while 8765 is a `free_mac` app. Double-click / open `第二步：双击我开始MedDRA浏览.html` as `file://` with no sidecar. Page stays on “还没有检测到便携版服务”.
- **Expected:** After step 1 is ready, step 2 opens the actual selected port without requiring localhost fetch.
- **Actual:** Helper only probes `startPort()…+19` via fetch/JSONP. `8861` is never probed. On Windows, even in-range probes can be blocked.
- **Locator:** `portable-index.html` (baseline `checkServer` / `startPort`); `scripts/run_portable_server.py` (no sidecar at baseline).
- **Fix:** Launcher writes `portable-active-port.js` + `当前服务地址.txt`. Step 2 loads the sidecar and does a top-level navigation to that URL (works even when `file://` cannot fetch loopback). Also answers Private Network Access preflight on `/api/runtime-info`.
- **Retest:** Round 1 and Round 2 file:// + sidecar → `http://127.0.0.1:8861/`. Unit tests in `test_portable_discovery.py`.

### P2 — Parent-folder dictionary discovery walked `node_modules` / worktrees (`rglob`)

- **Platform:** all; triggered by the documented “选上级文件夹” path when the parent is the MedDRA workspace.
- **Reproduction:** `iter_dictionary_dirs()` on a tree that contains `qa-worktrees/**/node_modules` plus a real `MedAscii` sibling. Baseline yielded `node_modules` hits.
- **Expected:** Find ASCII releases without descending into package/worktree junk; stay bounded.
- **Actual:** `Path.rglob("soc.asc")` walked everything; skip of `meddra-browser-mac` happened *after* the walk.
- **Locator:** `backend/app/meddra_data.py` former `iter_dictionary_dirs` / `contains_meddra_ascii`.
- **Fix:** Explicit stack walk, skip `node_modules`, `.git`, venvs, `qa-worktrees`, `meddra-browser-mac`, dot-dirs; depth ≤ 6; dir cap 4000.
- **Retest:** unit tests + `POST /api/source-roots` of the real workspace root in 0.011 s.

### P3 — Portable settings error still told Windows users to use `MedDRA Browser Mac.app`

- **Platform:** any portable build that surfaced the App Store picker error (should be rare because launchers force `MEDDRA_APP_STORE_MODE=0`).
- **Locator:** `frontend/src/App.tsx` `sourceImportErrorMessage`.
- **Fix:** Platform-neutral wording (“便携版或普通桌面版 MedDRA Browser”).
- **Retest:** UI header/settings contain no `Mac.app`. Frontend package name also renamed off `meddra-browser-mac-frontend`.

### P4 — Portable zip writer did not set UTF-8 flags explicitly; wheelhouse rebuild always re-downloaded

- **Platform:** Windows Explorer / some unzip tools; packaging machines.
- **Locator:** `scripts/build_portable_package.sh` `make_zip` / wheelhouse block.
- **Fix:** `ZipInfo.flag_bits |= 0x800`, `strict_timestamps=False`; reuse an existing wheelhouse when present (zsh-safe `ls`).
- **Retest:** rebuilt zip Chinese names have UTF-8 bit; `ditto` extract names are correct.

No P0 was reproduced (service did start; identity was portable; indexes completed). The reported Windows “no service detected” is the P1 above.

Closed / not defects:

- Empty Research Bin “清空” disabled — expected.
- Browser console `400` on intentional bad import — expected.
- `file://` helper without sidecar cannot see 8861 — remaining limitation **mitigated** by sidecar written next to the real step-2 file.
- Worktree tests using `parents[3]` pointed at `qa-worktrees` instead of the MedDRA workspace — test harness only; fixed via `workspace_paths.py`.

---

## 7. Files changed

- `portable-index.html` — sidecar load + top-level redirect + clearer occupied-port copy
- `scripts/run_portable_server.py` — `write_active_port_sidecar()`
- `backend/app/main.py` — Private Network Access middleware
- `backend/app/meddra_data.py` — bounded dictionary walk
- `frontend/src/App.tsx` — portable-neutral import error
- `frontend/package.json`, `frontend/package-lock.json` — drop Mac-only package name
- `scripts/build_portable_package.sh` — UTF-8 zip flags, wheelhouse reuse, README text
- `README.md` — sidecar / occupied-port usage
- `.gitignore` — `.qa-state`, `.qa-extract`, sidecar artifacts
- `backend/tests/test_portable_discovery.py` (new)
- `backend/tests/workspace_paths.py` (new)
- `backend/tests/test_api_manual_coverage.py`, `backend/tests/test_meddra_data.py`
- `scripts/qa_portable_round.py` (new QA driver)

---

## 8. Commits

Source changes committed in this worktree only, message prefix `qa(grok):`. No push, no publish.

---

## 9. Test / build output summaries

- Baseline portable tests: 5 failed + 1 error (`runs/conference/meddra-portable-qa-012/round1-baseline-portable-tests.txt`)
- After fix portable tests: 8/8 OK
- API: 12/12 OK (12.0 s)
- Data: 19/19 OK (22.9 s)
- Round 1 UI: 19 checks OK (`round1-ui.txt`)
- Rebuild: `./scripts/build_portable_package.sh` → `build/meddra-browser-portable.zip`
- Round 2 UI: 19 checks OK (`round2-ui.txt`)
- Round 2 units: 39/39 OK (34.5 s)

---

## 10. Disk / process cleanup

- Stopped QA servers we started (source PID 21609, extract PID 22718). Port 8861 is free.
- Did **not** stop `8765` Mac app or `8768` http.server.
- Did **not** modify raw dictionary files or user `~/Library/Application Support`.
- Left gitignored evidence: `.qa-state/` (~451 MB indexes), `.qa-extract/`, `logs/qa/`, `output/playwright/`, `build/`.
- No Trash emptied.

---

## 11. Consecutive-clean result

**Round 1 clean + Round 2 clean = 2 consecutive complete rounds with zero open P0/P1/P2/P3/P4 in the executed scope.**

---

## 12. Unverified platform limits

| Claim | Status | Evidence |
| --- | --- | --- |
| Native Windows double-click of `【Windows】第一步：请双击我运行.bat` | UNVERIFIED_PLATFORM | Host is macOS; bat not executed |
| Bundled `python-installer.exe` silent install to `.python_windows` | UNVERIFIED_PLATFORM | installer present (28 MB) but not run |
| Offline `wheelhouse` + `.venv_windows` on Windows | UNVERIFIED_PLATFORM | wheels packaged (`cp313-win_amd64`) only |
| Windows Explorer unzip of CJK names | UNVERIFIED_PLATFORM | UTF-8 flag verified; Explorer not run |
| Windows Edge/Chrome `file://` Private Network Access prompt | UNVERIFIED_PLATFORM | sidecar designed for this; not executed on Windows |
| Windows `FolderBrowserDialog` | UNVERIFIED_PLATFORM | PowerShell picker not run |

A successful Mac/source test is **not** a Windows pass.

---

## 13. Residual risks

- If a user copies only the HTML to another folder, the sidecar is left behind and 8861-class ports stay invisible. Real zip layout keeps them together.
- Two launchers racing before uvicorn binds can still collide on a free port (unchanged; not reproduced).
- First Windows run still needs the bundled installer + venv; that path is unverified.
- Selecting an extremely deep non-MedDRA tree is now capped, so a dictionary buried deeper than 6 levels will not be found. Real MSSO layouts are 1–3 levels (`ascii-290`, `MedAscii`).

---

## 14. Recommendation

**Accept the patched worktree as the 0.1.12 portable release candidate for source/Mac packaged runtime.** The reported “step 1 then step 2 shows no portable service”, Mac-app branding leak, App Store identity reuse, and parent-folder runaway walk are fixed and retested through two clean rounds.

Do **not** mark Windows as verified. A native Windows gate should still: unzip with Explorer, double-click step 1, wait for `.python_windows` / `.venv_windows`, confirm auto-open, then double-click step 2 as `file://` while 8765 is occupied by another process.
