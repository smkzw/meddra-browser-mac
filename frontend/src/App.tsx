import {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { openModal } from "./modal";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardList,
  Download,
  History,
  Languages,
  Layers,
  ListTree,
  Power,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import CodingWorkspace from "./CodingWorkspace";
import {
  CodingRuntimeState,
  ConfirmDialogState,
  Detail,
  HistoryEntry,
  IndexStatus,
  Mode,
  ModuleKey,
  PaneSide,
  PaneWidths,
  RelationNode,
  RelationshipTreeNode,
  ReleaseInfo,
  RuntimeInfo,
  SearchGroup,
  SearchLevel,
  SearchResult,
  SmqDetail,
  SourceRoot,
  Status,
  SynonymRow,
  TreeNode,
} from "./types";

const API = "/api";
const SEARCH_PLACEHOLDER = "可输入AE/MH名称进行模糊查询或输入代码进行精确查询";
const ADVANCED_PLACEHOLDER = "可输入AE/MH名称、中文/英文片段或代码";
const DEFAULT_PANES: PaneWidths = { left: 300, right: 332 };
const MIN_LEFT_PANE_WIDTH = 230;
const MAX_LEFT_PANE_WIDTH = 500;
const MIN_RIGHT_PANE_WIDTH = 268;
const MAX_RIGHT_PANE_WIDTH = 540;
const STACKED_WORKSPACE_WIDTH = 1100;
const RESIZER_WIDTH_TOTAL = 16;

const LEVEL_OPTIONS: Array<{ key: SearchLevel; label: string; hint: string }> = [
  { key: "PT", label: "PT", hint: "默认" },
  { key: "LLT", label: "LLT", hint: "含非当前" },
  { key: "HLT", label: "HLT", hint: "上位" },
  { key: "HLGT", label: "HLGT", hint: "上位" },
  { key: "SOC", label: "SOC", hint: "顶层" },
  { key: "SMQ", label: "SMQ", hint: "广义/狭义" },
];

const MODULES: Array<{ key: ModuleKey; label: string; icon: JSX.Element }> = [
  { key: "search", label: "搜索", icon: <Search size={15} /> },
  { key: "advanced", label: "高级搜索", icon: <SlidersHorizontal size={15} /> },
  { key: "browse", label: "层级浏览", icon: <ListTree size={15} /> },
  { key: "coding", label: "批量编码", icon: <ClipboardList size={15} /> },
  { key: "detail", label: "详情关系", icon: <Layers size={15} /> },
  { key: "bin", label: "Research Bin", icon: <Clipboard size={15} /> },
  { key: "history", label: "历史记录", icon: <History size={15} /> },
];

type SearchCursor = { request: Record<string, unknown>; offset: number; source: string };

function detectMobileWorkspace() {
  if (typeof window === "undefined") return false;
  const userAgent = window.navigator.userAgent || "";
  const touchDevice = window.navigator.maxTouchPoints > 1 || window.matchMedia("(pointer: coarse)").matches;
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const ipadDesktopMode = touchDevice && /Macintosh/i.test(userAgent);
  return (mobileUserAgent || ipadDesktopMode) && window.innerWidth <= 1180;
}

function defaultPaneWidthsForViewport(): PaneWidths {
  if (typeof window === "undefined") return DEFAULT_PANES;
  if (window.innerWidth <= 1360) return { left: 268, right: 296 };
  if (window.innerWidth >= 1980) return { left: 320, right: 368 };
  return DEFAULT_PANES;
}

function displayName(item: { en_name?: string; zh_name?: string }, mode: Mode) {
  if (mode === "en") return item.en_name || item.zh_name || "";
  if (mode === "zh") return item.zh_name || item.en_name || "";
  if (item.en_name && item.zh_name && item.en_name !== item.zh_name) {
    return `${item.zh_name} / ${item.en_name}`;
  }
  return item.zh_name || item.en_name || "";
}

function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8") {
  // Excel on Chinese Windows assumes the system codepage (GBK) unless a UTF-8 BOM is present,
  // which would garble Chinese MedDRA terms. JSON must stay BOM-free so JSON.parse works.
  const needsBom = mime.includes("text/csv") && !text.startsWith("\ufeff");
  const blob = new Blob([needsBom ? `\ufeff${text}` : text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Defer URL revocation for WKDownload handoff in macOS native WKWebView.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function rowsToCsv(rows: object[]) {
  if (!rows.length) return "";
  const normalizedRows = rows.map((row) => row as Record<string, unknown>);
  const columns = Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row))));
  const escape = (value: unknown) => {
    const raw = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) && !/^[-+]?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [columns.join(","), ...normalizedRows.map((row) => columns.map((col) => escape(row[col])).join(","))].join("\n");
}

function apiPath(path: string, version?: string) {
  if (!version) return `${API}${path}`;
  const separator = path.includes("?") ? "&" : "?";
  return `${API}${path}${separator}version=${encodeURIComponent(version)}`;
}

function versionSortKey(versionValue: string) {
  const match = versionValue.match(/(\d+)\.(\d+)/);
  if (!match) return [0, 0];
  return [Number(match[1]), Number(match[2])];
}

function sortReleases(releases: ReleaseInfo[]) {
  return [...releases].sort((a, b) => {
    const [majorA, minorA] = versionSortKey(a.version);
    const [majorB, minorB] = versionSortKey(b.version);
    return majorB - majorA || minorB - minorA;
  });
}

function mergeReleases(releases: ReleaseInfo[]) {
  const merged = new Map<string, ReleaseInfo>();
  releases.forEach((release) => {
    const current = merged.get(release.version);
    if (!current) {
      merged.set(release.version, { ...release, available_languages: [...(release.available_languages || [])] });
      return;
    }
    const languages = Array.from(new Set([...(current.available_languages || []), ...(release.available_languages || [])]));
    merged.set(release.version, {
      ...current,
      complete: current.complete || release.complete || (languages.includes("en") && languages.includes("zh")),
      usable: current.usable || release.usable,
      available_languages: languages,
      missing_languages: ["en", "zh"].filter((lang) => !languages.includes(lang)),
    });
  });
  return sortReleases(Array.from(merged.values()));
}

function apiErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    const detail = row.detail || row.error || row.message;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object") {
      const nested = detail as Record<string, unknown>;
      const nestedMessage = nested.message || nested.detail || nested.error;
      if (typeof nestedMessage === "string" && nestedMessage.trim()) return nestedMessage;
    }
  }
  return fallback;
}

function isMissingDictionaryMessage(message: string) {
  return message.includes("未发现可用的MedDRA") || message.includes("加入词典来源") || message.includes("还没有发现可用词典");
}

function isAppStoreCandidateMessage(message: string) {
  return message.includes("App Store沙盒候选模式") || message.includes("安全作用域书签");
}

function sourceImportErrorMessage(error: unknown, fallback: string) {
  const message = (error as Error)?.message || "";
  if (isAppStoreCandidateMessage(message)) {
    return "当前是 App Store 候选版，暂不支持从这里导入外部词典。请改用便携版或普通桌面版 MedDRA Browser。正式沙盒版需要原生文件夹选择器。";
  }
  return message || fallback;
}

function isIndexWaitingMessage(message: string) {
  return (
    message.includes("index_not_ready") ||
    message.includes("索引仍在准备") ||
    message.includes("索引正在准备") ||
    message.includes("等待进度条完成")
  );
}

function formatInteger(value?: number) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function indexPercent(status: IndexStatus | null) {
  return clamp(Number(status?.percent || 0), 0, 100);
}

function indexProgressNotice(status: IndexStatus | null) {
  if (!status) return "正在检查本地词典索引...";
  if (status.state === "ready") return `MedDRA ${status.version || ""} 索引已完成。`;
  if (status.state === "error") return status.error || status.message || "索引失败，请检查词典目录后重试。";
  const rows = status.total_rows
    ? `${formatInteger(status.processed_rows)} / ${formatInteger(status.total_rows)} 条处理记录`
    : "正在统计处理记录";
  return `${status.message || "正在创建本地索引"} · ${indexPercent(status)}% · ${rows}`;
}

async function readJsonResponse(res: Response) {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (!res.ok) {
      throw new Error(res.status >= 500 ? "本地词典索引正在准备或服务正在启动，请稍后再试" : text.slice(0, 160));
    }
    throw new Error("本地服务返回了无法解析的数据");
  }
}

async function fetchJson<T = any>(input: RequestInfo | URL, init?: RequestInit, fallback = "请求失败"): Promise<T> {
  const res = await fetch(input, init);
  const data = await readJsonResponse(res);
  if (!res.ok) {
    throw new Error(apiErrorMessage(data, fallback));
  }
  return data as T;
}

function isCodeQuery(text: string) {
  return /^\d{2,}$/.test(text.trim());
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function desiredCenterWidth(workspaceWidth: number) {
  if (!workspaceWidth || workspaceWidth <= STACKED_WORKSPACE_WIDTH) return 420;
  const sideBudget = MIN_LEFT_PANE_WIDTH + MIN_RIGHT_PANE_WIDTH + RESIZER_WIDTH_TOTAL;
  const available = Math.max(420, workspaceWidth - sideBudget);
  if (workspaceWidth >= 1700) return Math.min(900, available);
  if (workspaceWidth >= 1300) return Math.min(Math.round(workspaceWidth * 0.52), available);
  return Math.min(Math.round(workspaceWidth * 0.5), available);
}

function normalizePaneWidths(widths: PaneWidths, workspaceWidth: number): PaneWidths {
  if (!workspaceWidth || workspaceWidth <= STACKED_WORKSPACE_WIDTH) return widths;
  const centerMin = desiredCenterWidth(workspaceWidth);
  const sideBudget = Math.max(
    MIN_LEFT_PANE_WIDTH + MIN_RIGHT_PANE_WIDTH,
    workspaceWidth - RESIZER_WIDTH_TOTAL - centerMin
  );
  let left = clamp(widths.left, MIN_LEFT_PANE_WIDTH, Math.min(MAX_LEFT_PANE_WIDTH, sideBudget - MIN_RIGHT_PANE_WIDTH));
  let right = clamp(widths.right, MIN_RIGHT_PANE_WIDTH, Math.min(MAX_RIGHT_PANE_WIDTH, sideBudget - left));
  if (left + right > sideBudget) {
    const overflow = left + right - sideBudget;
    right = clamp(right - overflow, MIN_RIGHT_PANE_WIDTH, MAX_RIGHT_PANE_WIDTH);
  }
  if (left + right > sideBudget) {
    left = clamp(sideBudget - right, MIN_LEFT_PANE_WIDTH, MAX_LEFT_PANE_WIDTH);
  }
  return { left: Math.round(left), right: Math.round(right) };
}

function samePaneWidths(a: PaneWidths, b: PaneWidths) {
  return a.left === b.left && a.right === b.right;
}

function MobileWorkspaceNotice() {
  return (
    <main className="mobile-gate">
      <img src="/brand/app-icon-256.png" alt="" aria-hidden="true" />
      <h1>建议使用电脑端打开</h1>
      <p>
        MedDRA 编码查询需要同时查看层级树、详情关系、Research Bin 和导出结果。手机或小尺寸平板会影响医学编码判断，请在 Mac 或 Windows 的桌面浏览器中使用。
      </p>
      <span>本地词典数据不会上传；请在电脑端启动同一套 MedDRA Browser。</span>
    </main>
  );
}

export default function App() {
  const [mobileWorkspace, setMobileWorkspace] = useState(() => detectMobileWorkspace());
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [serviceStopped, setServiceStopped] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [indexRefreshKey, setIndexRefreshKey] = useState(0);
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<Mode>("both");
  const [module, setModule] = useState<ModuleKey>("search");

  const [treeTab, setTreeTab] = useState<"soc" | "smq">("soc");
  const [treeFilter, setTreeFilter] = useState("");
  const [narrowLeftOpen, setNarrowLeftOpen] = useState(false);
  const [narrowRightOpen, setNarrowRightOpen] = useState(false);
  const [socRoots, setSocRoots] = useState<TreeNode[]>([]);
  const [smqRoots, setSmqRoots] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, TreeNode[]>>({});

  const [browseStack, setBrowseStack] = useState<TreeNode[]>([]);
  const [browseChildren, setBrowseChildren] = useState<TreeNode[]>([]);
  const [browsePage, setBrowsePage] = useState(1);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");

  const [query, setQuery] = useState("");
  const [socFilter, setSocFilter] = useState("");
  const [selectedLevels, setSelectedLevels] = useState<SearchLevel[]>(["PT"]);
  const [searchGroups, setSearchGroups] = useState<SearchGroup[]>([]);
  const [searchCursor, setSearchCursor] = useState<SearchCursor | null>(null);
  const [searchRun, setSearchRun] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [historyCursor, setHistoryCursor] = useState(-1);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [smqDetail, setSmqDetail] = useState<SmqDetail | null>(null);
  const [detailError, setDetailError] = useState("");

  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusNotice, setStatusNotice] = useState("");
  const [toast, setToast] = useState("");

  const [includeSynonyms, setIncludeSynonyms] = useState(true);
  const [ignoreDiacritics, setIgnoreDiacritics] = useState(true);
  const [includeNonCurrent, setIncludeNonCurrent] = useState(true);

  const [advA, setAdvA] = useState("");
  const [advB, setAdvB] = useState("");
  const [advOpA, setAdvOpA] = useState("contains");
  const [advOpB, setAdvOpB] = useState("contains");
  const [advBool, setAdvBool] = useState("AND");
  const [advancedResults, setAdvancedResults] = useState<SearchResult[]>([]);
  const [advancedCursor, setAdvancedCursor] = useState<SearchCursor | null>(null);
  const [advancedTotal, setAdvancedTotal] = useState(0);
  const [advPage, setAdvPage] = useState(1);
  const [hasAdvancedSearched, setHasAdvancedSearched] = useState(false);
  const [advancedError, setAdvancedError] = useState("");

  const [synonyms, setSynonyms] = useState<SynonymRow[]>([]);
  const [synonymStatus, setSynonymStatus] = useState("");
  const [sourceRoots, setSourceRoots] = useState<SourceRoot[]>([]);
  const [sourcePath, setSourcePath] = useState("");
  const [importingSource, setImportingSource] = useState(false);

  const [bin, setBin] = useState<SearchResult[]>(() => readStorage<SearchResult[]>("meddra.bin", []));
  const [binFilter, setBinFilter] = useState("");
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() =>
    readStorage<PaneWidths>("meddra.panes", defaultPaneWidthsForViewport())
  );
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [historyRows, setHistoryRows] = useState<HistoryEntry[]>(() =>
    readStorage<HistoryEntry[]>("meddra.history", [])
  );

  const [codingState, setCodingState] = useState<CodingRuntimeState>({
    dirty: false,
    boundVersion: "",
    pendingCount: 0,
    totalCount: 0,
  });
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const importRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const confirmDialogRef = useRef<HTMLDialogElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const advAbortRef = useRef<AbortController | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const versionRef = useRef(version);
  const treeReqRef = useRef(0);
  const detailReqRef = useRef(0);
  const browseReqRef = useRef(0);
  const advReqRef = useRef(0);
  const synReqRef = useRef(0);

  versionRef.current = version;

  const flash = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 2400);
  }, []);

  // Sync window.__meddraHasUnsavedWork for native WKWebView close guard
  useEffect(() => {
    window.__meddraHasUnsavedWork = Boolean(codingState.dirty && !serviceStopped);
    return () => {
      window.__meddraHasUnsavedWork = false;
    };
  }, [codingState.dirty, serviceStopped]);

  // Warn before closing/reloading browser tab when unexported coding draft exists
  useEffect(() => {
    if (!codingState.dirty || serviceStopped) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [codingState.dirty, serviceStopped]);

  useEffect(() => {
    if (confirmDialog) return openModal(confirmDialogRef.current, () => setConfirmDialog(null));
  }, [confirmDialog]);

  useEffect(() => {
    const update = () => setMobileWorkspace(detectMobileWorkspace());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // Fetch /api/runtime-info once
  useEffect(() => {
    if (mobileWorkspace || serviceStopped) return;
    let cancelled = false;
    fetchJson<RuntimeInfo>(`${API}/runtime-info`, { cache: "no-store" })
      .then((info) => {
        if (!cancelled) setRuntimeInfo(info);
      })
      .catch(() => {
        /* ignore if unavailable in dev proxy */
      });
    return () => {
      cancelled = true;
    };
  }, [mobileWorkspace, serviceStopped]);

  // Poll /api/index-status & /api/status (stops immediately when serviceStopped === true)
  useEffect(() => {
    if (mobileWorkspace || serviceStopped) return;
    let cancelled = false;
    let timer: number | undefined;
    const targetVersion = version;
    const maxAttempts = targetVersion ? 160 : 4;
    setStatusLoading(true);
    setStatusNotice(targetVersion ? `正在检查 MedDRA ${targetVersion} 本地索引...` : "正在检查本地 MedDRA 词典...");

    const loadStatus = (attempt = 0) => {
      fetchJson<IndexStatus>(apiPath("/index-status?start=true", targetVersion), undefined, "后端未找到可用的MedDRA词典目录")
        .then((indexData) => {
          if (cancelled) return;
          setIndexStatus(indexData);
          if (indexData.state === "error") {
            setStatusLoading(false);
            setStatusNotice(indexProgressNotice(indexData));
            return;
          }
          if (indexData.state !== "ready") {
            setStatusLoading(true);
            setStatusNotice(indexProgressNotice(indexData));
            timer = window.setTimeout(() => loadStatus(attempt + 1), 900);
            return;
          }
          fetchJson<Status>(apiPath("/status", targetVersion || indexData.version), undefined, "状态刷新失败")
            .then((data) => {
              if (cancelled) return;
              setStatus(data);
              if (!targetVersion) setVersion(data.version);
              setStatusLoading(false);
              setStatusNotice("");
            })
            .catch((error) => {
              if (cancelled) return;
              const message = (error as Error).message || "";
              if (isIndexWaitingMessage(message) && attempt + 1 < maxAttempts) {
                setStatusNotice("本地词典索引正在收尾，请稍候...");
                timer = window.setTimeout(() => loadStatus(attempt + 1), 900);
                return;
              }
              setStatusLoading(false);
              setStatusNotice(message || "状态刷新失败");
            });
        })
        .catch((error) => {
          if (cancelled) return;
          const message = (error as Error).message || "";
          if (isMissingDictionaryMessage(message)) {
            setIndexStatus(null);
            setStatusLoading(false);
            setStatusNotice("还没有绑定 MedDRA 词典，请直接点击“选择词典文件夹”。");
            return;
          }
          if (attempt + 1 < maxAttempts) {
            setStatusNotice(targetVersion ? `正在准备 MedDRA ${targetVersion} 本地索引，请稍候...` : "正在等待本地服务和词典索引...");
            timer = window.setTimeout(() => loadStatus(attempt + 1), 1200);
            return;
          }
          setStatusLoading(false);
          if (targetVersion) {
            setStatusNotice(`MedDRA ${targetVersion} 暂时未载入完成，可稍后重试或在设置中重建当前版本。`);
            flash(message || `MedDRA ${targetVersion} 载入失败`);
          } else {
            setStatusNotice("还没有发现可用词典，请点击“选择词典文件夹”绑定本地目录。");
          }
        });
    };

    loadStatus();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [version, mobileWorkspace, indexRefreshKey, serviceStopped, flash]);

  useEffect(() => {
    if (mobileWorkspace || serviceStopped) return;
    void refreshSourceRoots();
  }, [mobileWorkspace, serviceStopped]);

  // Load SOC / SMQ roots whenever ready version or mode changes (race-guarded)
  useEffect(() => {
    if (serviceStopped || !version || mobileWorkspace || status?.version !== version || indexStatus?.state !== "ready") {
      setSocRoots([]);
      setSmqRoots([]);
      setExpanded({});
      return;
    }
    const reqId = ++treeReqRef.current;
    const reqVersion = version;
    fetchJson<{ nodes: TreeNode[] }>(apiPath(`/tree/soc?mode=${mode}`, reqVersion), undefined, "SOC层级加载失败")
      .then((data) => {
        if (reqId === treeReqRef.current && reqVersion === versionRef.current) {
          setSocRoots(data.nodes || []);
        }
      })
      .catch((error) => {
        if (reqId === treeReqRef.current) handleApiError(error, "SOC层级加载失败");
      });
    fetchJson<{ nodes: TreeNode[] }>(apiPath(`/tree/smq?mode=${mode}`, reqVersion), undefined, "SMQ层级加载失败")
      .then((data) => {
        if (reqId === treeReqRef.current && reqVersion === versionRef.current) {
          setSmqRoots(data.nodes || []);
        }
      })
      .catch((error) => {
        if (reqId === treeReqRef.current) handleApiError(error, "SMQ层级加载失败");
      });
  }, [mode, version, status?.version, indexStatus?.state, mobileWorkspace, serviceStopped]);

  useEffect(() => {
    writeStorage("meddra.bin", bin);
  }, [bin]);

  useEffect(() => {
    writeStorage("meddra.history", historyRows);
  }, [historyRows]);

  useEffect(() => {
    writeStorage("meddra.panes", paneWidths);
  }, [paneWidths]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      setWorkspaceWidth(width);
      setPaneWidths((current) => {
        const normalized = normalizePaneWidths(current, width);
        return samePaneWidths(current, normalized) ? current : normalized;
      });
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [serviceStopped]);

  // Global keyboard shortcuts: `/` focuses search, `Alt+1..8` switches modules
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isInput = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"));
      if (event.key === "/" && !isInput && !confirmDialog) {
        event.preventDefault();
        setModule("search");
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const digit = Number(event.key);
        if (digit >= 1 && digit <= MODULES.length) {
          event.preventDefault();
          setModule(MODULES[digit - 1].key);
        } else if (digit === 8) {
          event.preventDefault();
          setModule("settings");
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [confirmDialog]);

  const flattenedSearchRows = useMemo(() => searchGroups.flatMap((group) => group.results), [searchGroups]);
  const binKeys = useMemo(() => new Set(bin.map((row) => `${row.level}:${row.code}`)), [bin]);
  const sourceReleases = useMemo(() => mergeReleases(sourceRoots.flatMap((root) => root.releases || [])), [sourceRoots]);
  const availableVersions = useMemo(
    () => (status?.available_versions?.length ? status.available_versions : sourceReleases),
    [status?.available_versions, sourceReleases]
  );
  const versionReady = Boolean(version && status?.version === version && indexStatus?.state === "ready" && !serviceStopped);

  const selectedRelease = useMemo(
    () => availableVersions.find((row) => row.version === version) || null,
    [availableVersions, version]
  );
  const activeLanguages = useMemo(
    () => status?.available_languages || selectedRelease?.available_languages || [],
    [status?.available_languages, selectedRelease]
  );
  const hasZh = !activeLanguages.length || activeLanguages.includes("zh");
  const hasEn = !activeLanguages.length || activeLanguages.includes("en");
  const activeLanguageLabel = useMemo(() => {
    if (!activeLanguages.length) return "";
    if (activeLanguages.includes("zh") && activeLanguages.includes("en")) return "双语";
    if (activeLanguages.includes("zh")) return "仅中文";
    return "仅英文";
  }, [activeLanguages]);

  const sourceIdentity = versionReady ? status?.source_signature ?? "" : "";
  const searchSourceRef = useRef(sourceIdentity);
  searchSourceRef.current = sourceIdentity;

  const filteredTreeRoots = useMemo(() => {
    const raw = treeTab === "soc" ? socRoots : smqRoots;
    const f = treeFilter.trim().toLowerCase();
    if (!f) return raw;
    return raw.filter((node) => {
      const code = (node.code || node.smq_code || "").toLowerCase();
      return (
        code.includes(f) ||
        (node.zh_name || "").toLowerCase().includes(f) ||
        (node.en_name || "").toLowerCase().includes(f) ||
        (node.display_name || "").toLowerCase().includes(f)
      );
    });
  }, [treeTab, socRoots, smqRoots, treeFilter]);

  const filteredBinRows = useMemo(() => {
    const q = binFilter.trim().toLowerCase();
    if (!q) return bin;
    return bin.filter(
      (row) =>
        row.code.toLowerCase().includes(q) ||
        row.level.toLowerCase().includes(q) ||
        (row.zh_name || "").toLowerCase().includes(q) ||
        (row.en_name || "").toLowerCase().includes(q)
    );
  }, [bin, binFilter]);

  const activeSelectionKey = smqDetail?.smq
    ? `SMQ:${smqDetail.smq.smq_code || smqDetail.smq.code}`
    : detail?.term
      ? `${detail.term.level}:${detail.term.code}`
      : "";

  const canShutdownPortable =
    runtimeInfo?.distribution_mode === "portable" && runtimeInfo?.shutdown_available === true;
  const noDictionaryConfigured =
    !statusLoading && (!availableVersions.length || isMissingDictionaryMessage(statusNotice));

  const workspaceStyle = {
    "--left-pane-width": `${paneWidths.left}px`,
    "--right-pane-width": `${paneWidths.right}px`,
    "--center-pane-min": `${desiredCenterWidth(workspaceWidth)}px`,
  } as CSSProperties;

  function requireIndexReady(action: string) {
    if (versionReady) return true;
    const message =
      indexStatus?.state === "error"
        ? indexProgressNotice(indexStatus)
        : `词典索引仍在准备，请等待上方进度条完成后再${action}。`;
    setStatusNotice(message);
    flash(message);
    return false;
  }

  function handleApiError(error: unknown, fallback: string) {
    const message = (error as Error).message || fallback;
    if (isIndexWaitingMessage(message)) {
      setStatusNotice("词典索引仍在准备，请等待上方进度条完成后再操作。");
      return;
    }
    flash(message);
  }

  function applyVersionSwitch(nextVersion: string) {
    if (!nextVersion || nextVersion === versionRef.current) return;
    abortRef.current?.abort();
    advAbortRef.current?.abort();
    treeReqRef.current += 1;
    detailReqRef.current += 1;
    browseReqRef.current += 1;
    advReqRef.current += 1;
    synReqRef.current += 1;
    setVersion(nextVersion);
    setExpanded({});
    setSocRoots([]);
    setSmqRoots([]);
    setBrowseStack([]);
    setBrowseChildren([]);
    setBrowsePage(1);
    setSearchGroups([]);
    setSearchCursor(null);
    setHasSearched(false);
    setSearchError("");
    setAdvancedResults([]);
    setAdvancedCursor(null);
    setAdvancedTotal(0);
    setAdvPage(1);
    setHasAdvancedSearched(false);
    setAdvancedError("");
    setDetail(null);
    setSmqDetail(null);
    setDetailError("");
    setSynonyms([]);
    setSynonymStatus("");
  }

  function requestVersionChange(nextVersion: string) {
    if (!nextVersion || nextVersion === version) return;
    if (codingState.dirty && codingState.boundVersion && nextVersion !== codingState.boundVersion) {
      setConfirmDialog({
        title: `切换至 MedDRA ${nextVersion}？`,
        body: `批量编码工作区当前有尚未导出的草稿，绑定在 MedDRA ${codingState.boundVersion}。切换词典不会删除内存草稿，但会暂时锁定编码导出直到你切回原版本或重置重跑建议。`,
        actions: [
          { label: "保持当前版本", onClick: () => setConfirmDialog(null) },
          {
            label: `切换到 ${nextVersion}`,
            variant: "primary",
            onClick: () => {
              setConfirmDialog(null);
              applyVersionSwitch(nextVersion);
            },
          },
        ],
      });
      return;
    }
    applyVersionSwitch(nextVersion);
  }

  async function executePortableShutdown() {
    setShuttingDown(true);
    abortRef.current?.abort();
    advAbortRef.current?.abort();
    try {
      const response = await fetch(`${API}/runtime/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const data = await readJsonResponse(response).catch(() => ({}));
        throw new Error(apiErrorMessage(data, `退出失败 (${response.status})`));
      }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 600);
        try {
          const active = await fetchJson<RuntimeInfo>(
            `${API}/runtime-info`, { cache: "no-store", signal: controller.signal }
          );
          if (active.instance_id === runtimeInfo?.instance_id) continue;
        } catch (error) {
          if ((error as Error).name === "AbortError") continue;
        } finally {
          window.clearTimeout(timeout);
        }
        setServiceStopped(true);
        setStatusNotice("");
        return;
      }
      flash("本地服务仍在退出，可在启动窗口查看状态。");
    } catch (error) {
      // If socket dropped right after server initiated exit, verify once before treating as error.
      try {
        await fetch(`${API}/runtime-info`, { cache: "no-store" });
        flash((error as Error).message || "退出便携版失败");
      } catch {
        setServiceStopped(true);
        setStatusNotice("");
      }
    } finally {
      setShuttingDown(false);
    }
  }

  function requestPortableShutdown() {
    setConfirmDialog({
      title: "退出 MedDRA Browser 便携版？",
      body: "确认后将安全停止本地 Python 服务，页面内不再继续轮询。你的词典文件不会受影响。",
      warning: codingState.dirty
        ? "当前批量编码工作区仍有未导出的审阅草稿（仅保存在内存中，关闭后将丢失）。建议先返回导出。"
        : undefined,
      actions: codingState.dirty
        ? [
            { label: "取消", onClick: () => setConfirmDialog(null) },
            {
              label: "返回批量编码导出",
              onClick: () => {
                setConfirmDialog(null);
                setModule("coding");
              },
            },
            {
              label: "仍要退出便携版",
              variant: "danger",
              onClick: () => {
                setConfirmDialog(null);
                void executePortableShutdown();
              },
            },
          ]
        : [
            { label: "取消", onClick: () => setConfirmDialog(null) },
            {
              label: "确认退出便携版",
              variant: "danger",
              onClick: () => {
                setConfirmDialog(null);
                void executePortableShutdown();
              },
            },
          ],
    });
  }

  async function performSearch(text = query, append = false) {
    if (!requireIndexReady("搜索")) return;
    const reqVersion = versionRef.current;
    const reqSource = searchSourceRef.current;
    const cursor = append ? searchCursor : null;
    if (append && (!cursor || cursor.request.version !== reqVersion || cursor.source !== reqSource)) {
      setSearchCursor(null);
      setSearchError("词典索引已更新，请重新搜索。");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const searchText = text.trim();
    if (!append) {
      setSearchCursor(null);
      setSearchRun((n) => n + 1);
    }
    setLoading(true);
    setSearchError("");
    setModule("search");
    try {
      if (!append && isCodeQuery(searchText)) {
        const data = await fetchJson<{ matches?: Detail[] }>(
          apiPath(`/code/${encodeURIComponent(searchText)}`, reqVersion),
          { signal: controller.signal },
          "代码查询失败"
        );
        if (reqVersion !== versionRef.current || reqSource !== searchSourceRef.current || abortRef.current !== controller) return;
        const rows = ((data.matches || []) as Detail[]).map((row) => detailToResult(row)).filter(Boolean) as SearchResult[];
        setSearchGroups(rows.length ? [{ category: "code", label: "代码匹配", results: rows, count: rows.length }] : []);
        setHasSearched(true);
        if (data.matches?.[0]) {
          setDetail(data.matches[0]);
          setSmqDetail(null);
        }
        setHistoryCursor(0);
        addHistory({ action: "代码搜索", text: searchText, version: reqVersion });
        return;
      }
      const request = cursor?.request ?? {
        query: searchText,
        version: reqVersion,
        mode,
        levels: selectedLevels,
        soc_codes: socFilter ? [socFilter] : [],
        include_synonyms: includeSynonyms,
        ignore_diacritics: ignoreDiacritics,
        include_non_current: includeNonCurrent,
        limit_per_group: 80,
      };
      const data = await fetchJson<{ groups?: SearchGroup[]; next_offset?: number | null }>(
        `${API}/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, offset_per_group: cursor?.offset ?? 0 }),
          signal: controller.signal,
        },
        "术语搜索失败"
      );
      if (reqVersion !== versionRef.current || reqSource !== searchSourceRef.current || abortRef.current !== controller) return;
      setSearchGroups((previous) => {
        const groups = data.groups || [];
        if (!append) return groups;
        const existing = new Map(previous.map((group) => [group.category, group]));
        return groups.map((group) => {
          const results = [...(existing.get(group.category)?.results ?? []), ...group.results];
          return { ...group, results, count: results.length };
        });
      });
      setSearchCursor(data.next_offset == null ? null : { request, offset: data.next_offset, source: reqSource });
      setHasSearched(true);
      if (!append) {
        setHistoryCursor(0);
        addHistory({ action: "术语搜索", text: searchText, version: reqVersion });
      }
    } catch (error) {
      if ((error as DOMException).name !== "AbortError" && reqVersion === versionRef.current) {
        const msg = (error as Error).message || "搜索失败";
        setSearchError(msg);
        handleApiError(error, "搜索失败");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  async function performAdvancedSearch(append = false) {
    if (!requireIndexReady("高级搜索")) return;
    const reqVersion = versionRef.current;
    const reqSource = searchSourceRef.current;
    const cursor = append ? advancedCursor : null;
    if (append && (!cursor || cursor.request.version !== reqVersion || cursor.source !== reqSource)) {
      setAdvancedCursor(null);
      setAdvancedError("词典索引已更新，请重新搜索。");
      return;
    }
    advAbortRef.current?.abort();
    const controller = new AbortController();
    advAbortRef.current = controller;
    const reqId = ++advReqRef.current;
    if (!append) setAdvancedCursor(null);
    setLoading(true);
    setAdvancedError("");
    setModule("advanced");
    try {
      const request = cursor?.request ?? {
        mode,
        version: reqVersion,
        levels: selectedLevels,
        boolean: advBool,
        conditions: [
          { value: advA, operator: advOpA },
          { value: advB, operator: advOpB },
        ],
      };
      const data = await fetchJson<{
        results?: SearchResult[]; next_offset?: number | null; total_count?: number;
      }>(
        `${API}/advanced-search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, offset: cursor?.offset ?? 0 }),
          signal: controller.signal,
        },
        "高级搜索失败"
      );
      if (reqId !== advReqRef.current || reqVersion !== versionRef.current || reqSource !== searchSourceRef.current) return;
      const rows = data.results || [];
      setAdvancedResults((previous) => append ? [...previous, ...rows] : rows);
      setAdvancedCursor(data.next_offset == null ? null : { request, offset: data.next_offset, source: reqSource });
      setAdvancedTotal(data.total_count ?? rows.length);
      setHasAdvancedSearched(true);
      if (!append) {
        setAdvPage(1);
        addHistory({ action: "高级搜索", text: `${advA} ${advBool} ${advB}`, version: reqVersion });
      }
    } catch (error) {
      if ((error as DOMException).name !== "AbortError" && reqId === advReqRef.current) {
        setAdvancedError((error as Error).message || "高级搜索失败");
        handleApiError(error, "高级搜索失败");
      }
    } finally {
      if (reqId === advReqRef.current) setLoading(false);
    }
  }

  async function loadDetail(level: string, itemCode: string, options?: { switchModule?: boolean }) {
    if (!requireIndexReady("打开详情")) return;
    if (level === "SMQ") {
      await loadSmqDetail(itemCode, options);
      return;
    }
    const reqId = ++detailReqRef.current;
    const reqVersion = versionRef.current;
    setDetailError("");
    try {
      const data = await fetchJson<Detail>(
        apiPath(`/details/${encodeURIComponent(level)}/${encodeURIComponent(itemCode)}`, reqVersion),
        undefined,
        "详情加载失败"
      );
      if (reqId !== detailReqRef.current || reqVersion !== versionRef.current) return;
      setDetail(data);
      setSmqDetail(null);
      if (options?.switchModule !== false) {
        setModule("detail");
      }
      addHistory({ action: "打开详情", text: `${level} ${itemCode}`, level, code: itemCode, version: reqVersion });
    } catch (error) {
      if (reqId === detailReqRef.current) {
        setDetailError((error as Error).message || "详情加载失败");
        handleApiError(error, "详情加载失败");
      }
    }
  }

  async function loadSmqDetail(smqCode: string, options?: { switchModule?: boolean }) {
    if (!requireIndexReady("打开SMQ")) return;
    const reqId = ++detailReqRef.current;
    const reqVersion = versionRef.current;
    setDetailError("");
    try {
      const data = await fetchJson<SmqDetail>(
        apiPath(`/smq/${encodeURIComponent(smqCode)}?mode=${mode}`, reqVersion),
        undefined,
        "SMQ详情加载失败"
      );
      if (reqId !== detailReqRef.current || reqVersion !== versionRef.current) return;
      setSmqDetail(data);
      setDetail(null);
      if (options?.switchModule !== false) {
        setModule("detail");
      }
      addHistory({ action: "打开SMQ", text: smqCode, level: "SMQ", code: smqCode, version: reqVersion });
    } catch (error) {
      if (reqId === detailReqRef.current) {
        setDetailError((error as Error).message || "SMQ详情加载失败");
        handleApiError(error, "SMQ详情加载失败");
      }
    }
  }

  async function fetchTreeChildren(node: TreeNode, tab: "soc" | "smq" = treeTab, reqVersion = versionRef.current): Promise<TreeNode[]> {
    const codeValue = node.code || node.smq_code || "";
    const url =
      tab === "soc"
        ? apiPath(`/tree/soc?level=${encodeURIComponent(node.level)}&code=${encodeURIComponent(codeValue)}&mode=${mode}`, reqVersion)
        : apiPath(`/tree/smq?code=${encodeURIComponent(codeValue)}&mode=${mode}`, reqVersion);
    const data = await fetchJson<{ nodes?: TreeNode[] }>(url, undefined, "子级加载失败");
    return data.nodes || [];
  }

  async function openBrowse(node: TreeNode, stack?: TreeNode[]) {
    if (!requireIndexReady("层级浏览")) return;
    const reqId = ++browseReqRef.current;
    const reqVersion = versionRef.current;
    const nextStack = stack ? [...stack, node] : [...browseStack, node];
    setBrowseStack(nextStack);
    setBrowsePage(1);
    setBrowseError("");
    setModule("browse");
    setBrowseLoading(true);
    try {
      const children = await fetchTreeChildren(node, treeTab, reqVersion);
      if (reqId !== browseReqRef.current || reqVersion !== versionRef.current) return;
      setBrowseChildren(children);
      await loadDetail(node.level || "SOC", node.code || node.smq_code || "", { switchModule: false });
      addHistory({
        action: "层级浏览",
        text: `${node.level} ${node.code || node.smq_code || ""}`,
        level: node.level,
        code: node.code || node.smq_code || "",
        version: reqVersion,
      });
    } catch (error) {
      if (reqId === browseReqRef.current) {
        setBrowseChildren([]);
        setBrowseError((error as Error).message || "子级加载失败");
        handleApiError(error, "子级加载失败");
      }
    } finally {
      if (reqId === browseReqRef.current) setBrowseLoading(false);
    }
  }

  function popBrowse() {
    if (browseStack.length <= 1) {
      setBrowseStack([]);
      setBrowseChildren([]);
      return;
    }
    const nextStack = browseStack.slice(0, -1);
    const parent = nextStack[nextStack.length - 1];
    setBrowseStack(nextStack);
    void openBrowse(parent, nextStack.slice(0, -1));
  }

  async function expandTree(node: TreeNode) {
    if (!requireIndexReady("展开层级")) return;
    const key = `${treeTab}:${node.level}:${node.code || node.smq_code}`;
    if (expanded[key]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    const reqVersion = versionRef.current;
    const codeValue = node.code || node.smq_code;
    const url =
      treeTab === "soc"
        ? apiPath(`/tree/soc?level=${encodeURIComponent(node.level)}&code=${encodeURIComponent(codeValue || "")}&mode=${mode}`, reqVersion)
        : apiPath(`/tree/smq?code=${encodeURIComponent(codeValue || "")}&mode=${mode}`, reqVersion);
    try {
      const data = await fetchJson<{ nodes?: TreeNode[] }>(url, undefined, "子级加载失败");
      if (reqVersion !== versionRef.current) return;
      setExpanded((current) => ({ ...current, [key]: data.nodes || [] }));
    } catch (error) {
      handleApiError(error, "子级加载失败");
    }
  }

  async function loadSynonyms(lang: "en" | "zh" = mode === "en" ? "en" : "zh") {
    if (!requireIndexReady("查看同义词表")) return;
    const reqId = ++synReqRef.current;
    const reqVersion = versionRef.current;
    try {
      const data = await fetchJson<{ results?: SynonymRow[] }>(
        apiPath(`/synonyms?lang=${lang}&limit=120`, reqVersion),
        undefined,
        "同义词表加载失败"
      );
      if (reqId !== synReqRef.current || reqVersion !== versionRef.current) return;
      setSynonyms(data.results || []);
      setSynonymStatus(
        data.results?.length
          ? `已载入${lang === "zh" ? "中文" : "英文"}同义词表预览（前 ${data.results.length} 条）`
          : `未找到${lang === "zh" ? "中文" : "英文"}同义词表；如需启用，请把 MDB4 或 MDB41_D241_B123 同义词文件夹放在词典文件夹旁边。`
      );
      addHistory({ action: "同义词表", text: lang === "zh" ? "中文" : "英文", version: reqVersion });
    } catch (error) {
      if (reqId === synReqRef.current) handleApiError(error, "同义词表加载失败");
    }
  }

  function addHistory(entry: Omit<HistoryEntry, "at">) {
    setHistoryRows((rows) => [{ ...entry, at: new Date().toLocaleString("zh-CN") }, ...rows].slice(0, 100));
  }

  function addToBin(result: SearchResult) {
    const tagged: SearchResult = { ...result, version: result.version || version || undefined };
    setBin((rows) => {
      if (rows.some((row) => row.level === tagged.level && row.code === tagged.code)) {
        flash("已在 Research Bin");
        return rows;
      }
      flash("已加入 Research Bin");
      return [tagged, ...rows];
    });
  }

  function removeFromBin(result: SearchResult) {
    setBin((rows) => rows.filter((row) => row.code !== result.code || row.level !== result.level));
    flash("已从 Research Bin 移除");
  }

  function toggleLevel(level: SearchLevel) {
    setSelectedLevels((current) => {
      if (current.includes(level)) {
        const next = current.filter((item) => item !== level);
        return next.length ? next : ["PT"];
      }
      return [...current, level];
    });
  }

  function exportSearch() {
    downloadText("meddra_search_results.csv", rowsToCsv(flattenedSearchRows), "text/csv;charset=utf-8");
  }

  function exportBin() {
    downloadText("meddra_research_bin.json", JSON.stringify(bin, null, 2), "application/json;charset=utf-8");
  }

  function importBin(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const parsed = text.trim().startsWith("[") ? JSON.parse(text) : parseCsv(text);
        if (Array.isArray(parsed)) {
          setBin(parsed.map(normalizeBinRow).filter(Boolean) as SearchResult[]);
          flash("Research Bin 已导入");
        }
      } catch {
        flash("导入失败：文件不是有效 JSON 或 CSV");
      }
    };
    reader.readAsText(file);
  }

  function exportSmq() {
    if (!smqDetail?.content) return;
    downloadText(`smq_${smqDetail.smq?.smq_code || "export"}.csv`, rowsToCsv(smqDetail.content), "text/csv;charset=utf-8");
  }

  function exportTermHierarchies() {
    if (!detail?.term) return;
    const paths = detail.relationships?.hierarchy_paths || detail.hierarchies || [];
    const deduped = dedupeHierarchyPaths(paths, detail.term.level);
    downloadText(
      `meddra_hierarchy_${detail.term.level}_${detail.term.code}.csv`,
      rowsToCsv(deduped),
      "text/csv;charset=utf-8"
    );
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => flash("已复制")).catch(() => flash("复制失败"));
  }

  async function refreshSourceRoots() {
    try {
      const data = await fetchJson<{ roots?: SourceRoot[] }>(`${API}/source-roots`, undefined, "词典来源加载失败");
      setSourceRoots(data.roots || []);
    } catch (error) {
      flash((error as Error).message || "词典来源加载失败");
    }
  }

  function applySourceRootResult(data: { roots?: SourceRoot[]; releases?: ReleaseInfo[] }) {
    setSourceRoots(data.roots || []);
    setStatus((current) =>
      current ? { ...current, available_versions: data.releases || current.available_versions } : current
    );
    const releases = mergeReleases(data.releases || []);
    if (releases.length) {
      setVersion((current) => current || releases[0].version);
      setIndexRefreshKey((key) => key + 1);
    }
  }

  async function pickDictionarySource() {
    setImportingSource(true);
    try {
      const nativePicker = window.webkit?.messageHandlers?.chooseDictionary;
      if (nativePicker && typeof nativePicker.postMessage === "function") {
        const chosen = await nativePicker.postMessage(null);
        if (typeof chosen !== "string" || !chosen.trim()) {
          flash("已取消选择词典来源");
          return;
        }
        const data = await fetchJson<{ roots?: SourceRoot[]; releases?: ReleaseInfo[] }>(
          `${API}/source-roots`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: chosen.trim() }),
          },
          "绑定词典来源失败"
        );
        applySourceRootResult(data);
        setSourcePath("");
        flash("已绑定词典文件夹，正在建立本地索引");
        return;
      }

      const data = await fetchJson<{ status: string; roots?: SourceRoot[]; releases?: ReleaseInfo[] }>(
        `${API}/source-roots/pick`,
        { method: "POST" },
        "无法打开文件夹选择器"
      );
      if (data.status === "cancelled") {
        flash("已取消选择词典来源");
        return;
      }
      applySourceRootResult(data);
      setSourcePath("");
      flash("已绑定词典文件夹，正在建立本地索引");
    } catch (error) {
      flash(sourceImportErrorMessage(error, "无法打开文件夹选择器"));
    } finally {
      setImportingSource(false);
    }
  }

  async function addDictionarySourceFromPath() {
    if (!sourcePath.trim()) {
      flash("请先输入词典文件夹路径");
      return;
    }
    setImportingSource(true);
    try {
      const data = await fetchJson<{ roots?: SourceRoot[]; releases?: ReleaseInfo[] }>(
        `${API}/source-roots`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourcePath.trim() }),
        },
        "导入目录失败"
      );
      applySourceRootResult(data);
      setSourcePath("");
      flash("已绑定词典文件夹，正在建立本地索引");
    } catch (error) {
      flash(sourceImportErrorMessage(error, "导入目录失败"));
    } finally {
      setImportingSource(false);
    }
  }

  async function reindexCurrentVersion() {
    if (!version) {
      flash("请先绑定并选择一个 MedDRA 版本");
      return;
    }
    setImportingSource(true);
    try {
      const data = await fetchJson<IndexStatus>(apiPath("/reindex", version), { method: "POST" }, "重建索引失败");
      setIndexStatus(data);
      setStatusLoading(data.state !== "ready");
      setStatusNotice(indexProgressNotice(data));
      setIndexRefreshKey((key) => key + 1);
      flash(`已开始重建 MedDRA ${data.version || version} 索引`);
    } catch (error) {
      handleApiError(error, "重建索引失败");
    } finally {
      setImportingSource(false);
    }
  }

  function cancelSearch() {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    flash("已取消搜索");
  }

  function navigateSearchHistory(direction: number) {
    const rows = historyRows.filter((row) => row.action.includes("搜索"));
    if (!rows.length) return;
    const next = Math.min(rows.length - 1, Math.max(0, historyCursor + direction));
    setHistoryCursor(next);
    setQuery(rows[next].text);
    void performSearch(rows[next].text);
  }

  function startPaneResize(side: PaneSide, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const workspace = workspaceRef.current?.getBoundingClientRect();
    if (!workspace) return;
    const startX = event.clientX;
    const startLeft = paneWidths.left;
    const startRight = paneWidths.right;

    document.body.classList.add("resizing-panes");
    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const sideBudget = Math.max(
        MIN_LEFT_PANE_WIDTH + MIN_RIGHT_PANE_WIDTH,
        workspace.width - RESIZER_WIDTH_TOTAL - desiredCenterWidth(workspace.width)
      );
      setPaneWidths((current) => {
        if (side === "left") {
          const maxLeft = Math.max(MIN_LEFT_PANE_WIDTH, Math.min(MAX_LEFT_PANE_WIDTH, sideBudget - MIN_RIGHT_PANE_WIDTH));
          const left = clamp(startLeft + delta, MIN_LEFT_PANE_WIDTH, maxLeft);
          const right = clamp(current.right, MIN_RIGHT_PANE_WIDTH, Math.min(MAX_RIGHT_PANE_WIDTH, sideBudget - left));
          return normalizePaneWidths({ left, right }, workspace.width);
        }
        const maxRight = Math.max(MIN_RIGHT_PANE_WIDTH, Math.min(MAX_RIGHT_PANE_WIDTH, sideBudget - MIN_LEFT_PANE_WIDTH));
        const right = clamp(startRight - delta, MIN_RIGHT_PANE_WIDTH, maxRight);
        const left = clamp(current.left, MIN_LEFT_PANE_WIDTH, Math.min(MAX_LEFT_PANE_WIDTH, sideBudget - right));
        return normalizePaneWidths({ left, right }, workspace.width);
      });
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-panes");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }

  function handleResizerKeyDown(side: PaneSide, event: React.KeyboardEvent<HTMLDivElement>) {
    const workspace = workspaceRef.current?.getBoundingClientRect();
    const width = workspace?.width || window.innerWidth;
    if (event.key === "Home") {
      event.preventDefault();
      setPaneWidths(normalizePaneWidths(defaultPaneWidthsForViewport(), width));
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 24;
    const delta = event.key === "ArrowRight" ? step : -step;
    setPaneWidths((current) =>
      normalizePaneWidths(
        side === "left"
          ? { ...current, left: current.left + delta }
          : { ...current, right: current.right - delta },
        width
      )
    );
  }

  if (mobileWorkspace) return <MobileWorkspaceNotice />;

  if (serviceStopped) {
    return (
      <main className="stopped-screen">
        <section className="stopped-card kz-card">
          <div className="stopped-card-head">
            <img src="/brand/app-icon-256.png" alt="MedDRA Browser" />
            <div>
              <h1>MedDRA Browser 便携版服务已停止</h1>
              <span className="verbatim-sub">所有后端轮询已暂停 · 词典目录及本机环境完好保留</span>
            </div>
          </div>
          <p>
            本地 Python 服务已安全关闭，当前标签页不会继续发送请求。你可以关闭此浏览器标签页；如需重新使用，请按系统重新运行第一步启动器：
          </p>
          <div className="stopped-steps kz-thin">
            <div>
              <strong>Windows</strong>：双击文件夹中的 <code>【Windows】第一步：请双击我运行.bat</code>
            </div>
            <div>
              <strong>Mac</strong>：双击文件夹中的 <code>【Mac】第一步：请双击我运行.command</code>
            </div>
            <div>或重新运行第二步 HTML 入口页，自动发现新的服务端口。</div>
          </div>
          <div className="coding-hero-actions">
            <button
              type="button"
              className="kz-btn primary"
              onClick={async () => {
                try {
                  const info = await fetchJson<RuntimeInfo>(`${API}/runtime-info`, { cache: "no-store" });
                  setRuntimeInfo(info);
                  setServiceStopped(false);
                  setIndexRefreshKey((k) => k + 1);
                } catch {
                  flash("暂未检测到本地服务，请先重新运行第一步启动器。");
                }
              }}
            >
              <RotateCcw size={15} /> 重新检测连接
            </button>
          </div>
        </section>
        {toast && (
          <div className="toast" role="status">
            <span className="toast-dot" aria-hidden="true" />
            {toast}
          </div>
        )}
      </main>
    );
  }

  const BROWSE_PAGE_SIZE = 48;
  const browseTotalPages = Math.max(1, Math.ceil(browseChildren.length / BROWSE_PAGE_SIZE));
  const clampedBrowsePage = Math.min(browsePage, browseTotalPages);
  const pagedBrowseChildren = browseChildren.slice(
    (clampedBrowsePage - 1) * BROWSE_PAGE_SIZE,
    clampedBrowsePage * BROWSE_PAGE_SIZE
  );

  const ADV_PAGE_SIZE = 40;
  const advTotalPages = Math.max(1, Math.ceil(advancedResults.length / ADV_PAGE_SIZE));
  const clampedAdvPage = Math.min(advPage, advTotalPages);
  const pagedAdvancedResults = advancedResults.slice(
    (clampedAdvPage - 1) * ADV_PAGE_SIZE,
    clampedAdvPage * ADV_PAGE_SIZE
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/brand/app-icon-256.png" alt="MedDRA Browser" />
          <div>
            <h1>MedDRA Browser</h1>
            <div className="brand-meta">
              <span>本地词典工作台 · MedDRA {version || status?.version || "未绑定"}</span>
              {activeLanguageLabel && (
                <span className={`lang-pill${activeLanguages.length < 2 ? " is-single" : ""}`}>
                  {activeLanguageLabel}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="header-actions">
          <select
            className="version-select"
            value={version}
            title="选择MedDRA版本"
            disabled={statusLoading}
            onChange={(event) => requestVersionChange(event.target.value)}
          >
            {!availableVersions.length && <option value="">未绑定词典</option>}
            {availableVersions.map((release) => (
              <option key={release.version} value={release.version}>
                MedDRA {release.version}（{releaseLanguageLabel(release)}）
              </option>
            ))}
          </select>
          {statusNotice && <span className="status-notice" title={statusNotice}>{statusNotice}</span>}
          <div className="segmented" aria-label="数据库显示模式">
            {(["zh", "en", "both"] as Mode[]).map((item) => {
              const fallbackHint =
                item === "zh" && !hasZh
                  ? "当前版本仅含英文词典，将回退显示英文"
                  : item === "en" && !hasEn
                    ? "当前版本仅含中文词典，将回退显示中文"
                    : undefined;
              return (
                <button
                  key={item}
                  type="button"
                  title={fallbackHint}
                  className={[
                    mode === item ? "active" : "",
                    fallbackHint ? "is-fallback" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => setMode(item)}
                >
                  <Languages size={13} />
                  {item === "zh" ? "中文" : item === "en" ? "英文" : "双语"}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={`header-util-btn${module === "settings" ? " active" : ""}`}
            aria-pressed={module === "settings"}
            onClick={() => setModule("settings")}
            title="词典来源与索引设置（Alt+8）"
          >
            <Settings size={14} /> 设置
          </button>
          {canShutdownPortable && (
            <button
              type="button"
              className="portable-exit-btn"
              disabled={shuttingDown}
              onClick={requestPortableShutdown}
              title="停止本地便携版服务并关闭后端"
            >
              <Power size={13} /> 退出便携版
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            title="清空搜索"
            aria-label="清空搜索"
            onClick={() => {
              setQuery("");
              setSearchGroups([]);
              setSearchCursor(null);
              setHasSearched(false);
              setSearchError("");
              setAdvancedResults([]);
              setAdvancedCursor(null);
              setAdvancedTotal(0);
              setHasAdvancedSearched(false);
              setAdvancedError("");
              setDetail(null);
              setSmqDetail(null);
            }}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </header>

      <IndexProgressPanel
        status={indexStatus}
        visible={Boolean(indexStatus && (statusLoading || indexStatus.state !== "ready"))}
        onRetry={() => {
          if (version) void reindexCurrentVersion();
          else setIndexRefreshKey((k) => k + 1);
        }}
        onOpenSettings={() => setModule("settings")}
      />

      <div
        className={`workspace${module === "coding" ? " workspace--full" : ""}${
          narrowLeftOpen ? " narrow-left-open" : ""
        }${narrowRightOpen ? " narrow-right-open" : ""}`}
        ref={workspaceRef}
        style={workspaceStyle}
      >
        <aside className="left-pane">
          <div className="pane-tabs">
            <button type="button" className={treeTab === "soc" ? "active" : ""} onClick={() => setTreeTab("soc")}>
              <ListTree size={14} /> SOC层级
            </button>
            <button type="button" className={treeTab === "smq" ? "active" : ""} onClick={() => setTreeTab("smq")}>
              <Layers size={14} /> SMQ层级
            </button>
          </div>
          <div className="tree-filter-bar">
            <Search size={13} />
            <input
              value={treeFilter}
              onChange={(event) => setTreeFilter(event.target.value)}
              placeholder={`筛选 ${treeTab === "soc" ? "SOC" : "SMQ"} 名称或代码`}
              aria-label="筛选层级树"
            />
            {treeFilter && (
              <button
                type="button"
                className="tree-filter-clear"
                aria-label="清空层级筛选"
                onClick={() => setTreeFilter("")}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="tree-scroll">
            {!versionReady ? (
              <div className="empty-state">
                <span>
                  {statusLoading
                    ? "词典索引正在准备，完成后这里会显示SOC/SMQ层级。"
                    : "请先绑定本地 MedDRA ASCII 词典文件夹。"}
                </span>
                {noDictionaryConfigured && (
                  <button
                    type="button"
                    className="kz-btn primary"
                    disabled={importingSource}
                    onClick={() => void pickDictionarySource()}
                  >
                    <Upload size={14} /> 选择词典文件夹
                  </button>
                )}
              </div>
            ) : !filteredTreeRoots.length ? (
              <EmptyState text="当前筛选下无匹配节点" />
            ) : (
              filteredTreeRoots.map((node) => (
                <TreeRow
                  key={`${treeTab}:${node.code || node.smq_code}`}
                  node={node}
                  depth={0}
                  treeTab={treeTab}
                  mode={mode}
                  activeKey={activeSelectionKey}
                  expanded={expanded}
                  onExpand={expandTree}
                  onOpen={(opened) => {
                    if (treeTab === "smq") {
                      void loadSmqDetail(opened.smq_code || opened.code || "");
                      return;
                    }
                    void openBrowse(opened, []);
                  }}
                />
              ))
            )}
          </div>
        </aside>

        <div
          className="pane-resizer pane-resizer-left"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="调整左侧栏宽度"
          aria-valuemin={MIN_LEFT_PANE_WIDTH}
          aria-valuemax={MAX_LEFT_PANE_WIDTH}
          aria-valuenow={paneWidths.left}
          onPointerDown={(event) => startPaneResize("left", event)}
          onKeyDown={(event) => handleResizerKeyDown("left", event)}
        />

        <main className="center-pane">
          <nav className="module-nav" role="toolbar" aria-label="功能模块">
            {MODULES.map((item, index) => (
              <button
                key={item.key}
                type="button"
                className={module === item.key ? "active" : ""}
                tabIndex={module === item.key ? 0 : -1}
                onClick={() => setModule(item.key)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  const delta = event.key === "ArrowRight" ? 1 : -1;
                  const next = MODULES[(index + delta + MODULES.length) % MODULES.length];
                  setModule(next.key);
                  const buttons = event.currentTarget.parentElement?.querySelectorAll("button");
                  buttons?.[((index + delta + MODULES.length) % MODULES.length)]?.focus();
                }}
              >
                {item.icon}
                {item.label}
                {item.key === "bin" && bin.length > 0 && <span className="nav-badge">{bin.length}</span>}
                {item.key === "coding" && codingState.totalCount > 0 && (
                  <span className={`nav-badge${codingState.dirty ? " is-dirty" : ""}`}>
                    {codingState.pendingCount > 0 ? codingState.pendingCount : codingState.totalCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {module !== "coding" && (
            <div className="narrow-pane-toggles">
              <button
                type="button"
                className={narrowLeftOpen ? "active" : ""}
                aria-expanded={narrowLeftOpen}
                onClick={() => setNarrowLeftOpen((v) => !v)}
              >
                <ListTree size={13} /> {narrowLeftOpen ? "收起层级树" : "展开层级树 (SOC/SMQ)"}
              </button>
              <button
                type="button"
                className={narrowRightOpen ? "active" : ""}
                aria-expanded={narrowRightOpen}
                onClick={() => setNarrowRightOpen((v) => !v)}
              >
                <Layers size={13} /> {narrowRightOpen ? "收起关系面板" : "展开关系面板"}
              </button>
            </div>
          )}

          {module === "search" && (
            <section className="module">
              {noDictionaryConfigured && (
                <div className="no-dict-hero kz-card" role="region" aria-label="首次绑定 MedDRA 词典">
                  <div className="no-dict-hero-copy">
                    <strong>尚未绑定本地 MedDRA 词典目录</strong>
                    <span>
                      首次使用可直接在此选择本机词典文件夹（如 MedDRA_29_0_English / MedDRA_29_0_Chinese 或其上级目录），索引完全在本地生成。
                    </span>
                  </div>
                  <div className="no-dict-hero-actions">
                    <button
                      type="button"
                      className="kz-btn primary"
                      disabled={importingSource}
                      onClick={() => void pickDictionarySource()}
                    >
                      <Upload size={15} /> 选择词典文件夹
                    </button>
                    <button type="button" className="kz-btn" onClick={() => setModule("settings")}>
                      <Settings size={14} /> 查看来源与设置
                    </button>
                  </div>
                </div>
              )}
              <div className="query-bar">
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void performSearch()}
                  placeholder={SEARCH_PLACEHOLDER}
                />
                <button
                  type="button"
                  className="primary"
                  onClick={() => void performSearch()}
                  disabled={loading || !versionReady}
                >
                  <Search size={15} /> 搜索
                </button>
                <button type="button" onClick={cancelSearch} disabled={!loading}>
                  <Square size={13} /> 取消
                </button>
                <button type="button" onClick={exportSearch} disabled={!flattenedSearchRows.length}>
                  <Download size={15} /> 导出
                </button>
                <button type="button" onClick={() => setQuery("")}>
                  清除
                </button>
              </div>
              <div className="search-controls-compact kz-thin">
                <div className="filter-row">
                  <label>
                    SOC过滤
                    <select value={socFilter} onChange={(event) => setSocFilter(event.target.value)}>
                      <option value="">全部SOC</option>
                      {socRoots.map((soc) => (
                        <option key={soc.code} value={soc.code}>
                          {displayName(soc, mode)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => navigateSearchHistory(1)}>
                    上一条
                  </button>
                  <button type="button" onClick={() => navigateSearchHistory(-1)}>
                    下一条
                  </button>
                </div>
                <LevelFilter selectedLevels={selectedLevels} onToggle={toggleLevel} />
                <OptionsRow
                  includeSynonyms={includeSynonyms}
                  setIncludeSynonyms={setIncludeSynonyms}
                  ignoreDiacritics={ignoreDiacritics}
                  setIgnoreDiacritics={setIgnoreDiacritics}
                  includeNonCurrent={includeNonCurrent}
                  setIncludeNonCurrent={setIncludeNonCurrent}
                />
              </div>

              {searchError && (
                <div className="coding-banner error" role="alert" style={{ marginBottom: 8 }}>
                  <span className="coding-banner-text">
                    <X size={14} /> {searchError}
                  </span>
                  <button type="button" className="kz-btn" onClick={() => void performSearch()}>
                    重试
                  </button>
                </div>
              )}

              {hasSearched && !loading && !searchError && (
                <div className="search-summary-bar">
                  <span>
                    已加载 <strong>{flattenedSearchRows.length}</strong> / {searchGroups.reduce(
                      (total, group) => total + (group.total_count ?? group.count), 0)} 条 · MedDRA {version}
                  </span>
                  {searchCursor && (
                    <button type="button" className="mini" onClick={() => void performSearch(query, true)}>
                      加载下一批
                    </button>
                  )}
                </div>
              )}

              {loading ? (
                <EmptyState text="正在检索本地 MedDRA 词典…" />
              ) : hasSearched && !searchGroups.length ? (
                <div className="empty-state">
                  <span>未找到匹配结果（已按当前层级 {selectedLevels.join("/")} 与筛选条件过滤）。</span>
                  <button
                    type="button"
                    className="kz-btn"
                    onClick={() => {
                      setSocFilter("");
                      setSelectedLevels(["PT", "LLT"]);
                      setIncludeNonCurrent(true);
                    }}
                  >
                    放宽层级与 SOC 筛选
                  </button>
                </div>
              ) : (
                <SearchGroups
                  key={searchRun}
                  groups={searchGroups}
                  mode={mode}
                  activeKey={activeSelectionKey}
                  onOpen={loadDetail}
                  onBin={addToBin}
                  onRemove={removeFromBin}
                  binKeys={binKeys}
                />
              )}
            </section>
          )}

          {module === "advanced" && (
            <section className="module">
              <div className="search-controls-compact kz-thin">
                <LevelFilter selectedLevels={selectedLevels} onToggle={toggleLevel} />
                <div className="advanced-grid" style={{ marginBottom: 0 }}>
                  <select value={advOpA} onChange={(event) => setAdvOpA(event.target.value)} aria-label="条件1运算符">
                    <option value="contains">包含</option>
                    <option value="begins">开头为</option>
                    <option value="exact">完全等于</option>
                    <option value="ends">结尾为</option>
                  </select>
                  <input
                    value={advA}
                    onChange={(event) => setAdvA(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void performAdvancedSearch()}
                    placeholder={ADVANCED_PLACEHOLDER}
                  />
                  <select value={advBool} onChange={(event) => setAdvBool(event.target.value)} aria-label="布尔逻辑">
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                    <option value="NOT">NOT</option>
                  </select>
                  <select value={advOpB} onChange={(event) => setAdvOpB(event.target.value)} aria-label="条件2运算符">
                    <option value="contains">包含</option>
                    <option value="begins">开头为</option>
                    <option value="exact">完全等于</option>
                    <option value="ends">结尾为</option>
                  </select>
                  <input
                    value={advB}
                    onChange={(event) => setAdvB(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void performAdvancedSearch()}
                    placeholder={ADVANCED_PLACEHOLDER}
                  />
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void performAdvancedSearch()}
                    disabled={!versionReady || loading}
                  >
                    <Search size={15} /> 高级搜索
                  </button>
                </div>
              </div>
              {advancedError && (
                <div className="coding-banner error" role="alert" style={{ marginBottom: 8 }}>
                  <span className="coding-banner-text">{advancedError}</span>
                  <button type="button" className="kz-btn" onClick={() => void performAdvancedSearch()}>
                    重试
                  </button>
                </div>
              )}
              {hasAdvancedSearched && (
                <div className="search-summary-bar">
                  <span>
                    已加载 <strong>{advancedResults.length}</strong> / {advancedTotal} 条 · 第{" "}
                    {advancedResults.length ? (clampedAdvPage - 1) * ADV_PAGE_SIZE + 1 : 0}–
                    {Math.min(clampedAdvPage * ADV_PAGE_SIZE, advancedResults.length)} 条
                  </span>
                  {advancedCursor && (
                    <button type="button" className="mini" disabled={loading}
                      onClick={() => void performAdvancedSearch(true)}>
                      加载下一批
                    </button>
                  )}
                  {advTotalPages > 1 && (
                    <div className="coding-pagination-controls">
                      <button
                        type="button"
                        className="mini"
                        disabled={clampedAdvPage <= 1}
                        onClick={() => setAdvPage((p) => Math.max(1, p - 1))}
                      >
                        上一页
                      </button>
                      <span>
                        {clampedAdvPage} / {advTotalPages}
                      </span>
                      <button
                        type="button"
                        className="mini"
                        disabled={clampedAdvPage >= advTotalPages}
                        onClick={() => setAdvPage((p) => Math.min(advTotalPages, p + 1))}
                      >
                        下一页
                      </button>
                    </div>
                  )}
                </div>
              )}
              <ResultList
                results={pagedAdvancedResults}
                mode={mode}
                activeKey={activeSelectionKey}
                onOpen={loadDetail}
                onBin={addToBin}
                onRemove={removeFromBin}
                binKeys={binKeys}
                emptyText={hasAdvancedSearched ? "没有符合当前组合条件的术语" : "输入条件后点击高级搜索"}
              />
            </section>
          )}

          {module === "browse" && (
            <section className="module browse-module">
              {!browseStack.length ? (
                <EmptyState text="在左侧点击 SOC / HLGT / HLT，下层级会在这里展开浏览。" />
              ) : (
                <>
                  <nav className="browse-crumb" aria-label="层级路径">
                    {browseStack.map((item, index) => {
                      const isLast = index === browseStack.length - 1;
                      return (
                        <span key={`${item.level}-${item.code}-${index}`} className="browse-crumb-item">
                          {index > 0 && <ChevronRight size={12} />}
                          <button
                            type="button"
                            className={isLast ? "current" : ""}
                            disabled={isLast}
                            onClick={() => {
                              const stack = browseStack.slice(0, index + 1);
                              const node = stack[stack.length - 1];
                              setBrowseStack(stack.slice(0, -1));
                              void openBrowse(node, stack.slice(0, -1));
                            }}
                          >
                            {item.level} · {displayName(item, mode)}
                          </button>
                        </span>
                      );
                    })}
                  </nav>
                  <header className="browse-hero kz-card">
                    <div>
                      <span className={`level-badge level-${browseStack[browseStack.length - 1]?.level || "SOC"}`}>
                        {browseStack[browseStack.length - 1]?.level || ""}
                      </span>
                      <h2>{displayName(browseStack[browseStack.length - 1], mode)}</h2>
                      <p className="browse-code">
                        代码 {browseStack[browseStack.length - 1]?.code || browseStack[browseStack.length - 1]?.smq_code} ·
                        下级共 {browseChildren.length} 项
                      </p>
                    </div>
                    <div className="browse-actions">
                      <button type="button" onClick={popBrowse} disabled={browseStack.length <= 1}>
                        返回上级
                      </button>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          const current = browseStack[browseStack.length - 1];
                          if (current) void loadDetail(current.level || "SOC", current.code || "");
                        }}
                      >
                        <Layers size={14} /> 打开详情
                      </button>
                    </div>
                  </header>
                  {browseError && (
                    <div className="coding-banner error" role="alert">
                      <span className="coding-banner-text">{browseError}</span>
                    </div>
                  )}
                  {browseLoading ? (
                    <EmptyState text="正在加载下层级…" />
                  ) : browseChildren.length ? (
                    <>
                      {browseTotalPages > 1 && (
                        <div className="search-summary-bar">
                          <span>
                            显示 {(clampedBrowsePage - 1) * BROWSE_PAGE_SIZE + 1}–
                            {Math.min(clampedBrowsePage * BROWSE_PAGE_SIZE, browseChildren.length)} / 共{" "}
                            {browseChildren.length} 项
                          </span>
                          <div className="coding-pagination-controls">
                            <button
                              type="button"
                              className="mini"
                              disabled={clampedBrowsePage <= 1}
                              onClick={() => setBrowsePage((p) => Math.max(1, p - 1))}
                            >
                              上一页
                            </button>
                            <span>
                              {clampedBrowsePage} / {browseTotalPages}
                            </span>
                            <button
                              type="button"
                              className="mini"
                              disabled={clampedBrowsePage >= browseTotalPages}
                              onClick={() => setBrowsePage((p) => Math.min(browseTotalPages, p + 1))}
                            >
                              下一页
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="browse-grid">
                        {pagedBrowseChildren.map((child) => {
                          const code = child.code || child.smq_code || "";
                          const canDrill = child.has_children !== false && child.level !== "LLT";
                          return (
                            <article key={`${child.level}-${code}`} className="browse-card kz-card">
                              <div className="browse-card-top">
                                <span className={`level-badge level-${child.level}`}>{child.level}</span>
                                <em>{code}</em>
                              </div>
                              <h3>{displayName(child, mode)}</h3>
                              <div className="browse-card-actions">
                                {canDrill && (
                                  <button type="button" className="primary mini" onClick={() => void openBrowse(child)}>
                                    进入下级
                                  </button>
                                )}
                                <button type="button" className="mini" onClick={() => void loadDetail(child.level, code)}>
                                  详情
                                </button>
                                <button
                                  type="button"
                                  className="mini"
                                  onClick={() =>
                                    addToBin({
                                      level: child.level,
                                      level_label: child.level || "",
                                      code,
                                      en_name: child.en_name || "",
                                      zh_name: child.zh_name || "",
                                      is_current: child.is_current || "",
                                      category: "browse",
                                      category_label: "层级浏览",
                                      matched_field: "层级浏览",
                                      score: 100,
                                      reason: "来自层级浏览",
                                    })
                                  }
                                >
                                  收藏
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <EmptyState text="当前节点没有可展开的下层级。可点「打开详情」查看完整关系树。" />
                  )}
                </>
              )}
            </section>
          )}

          {/* Keep CodingWorkspace mounted in memory across tab switches */}
          <div className="module-slot" hidden={module !== "coding"}>
            <CodingWorkspace
              version={version}
              sourceIdentity={sourceIdentity}
              mode={mode}
              versionReady={versionReady}
              apiBase={API}
              flash={flash}
              onSessionStateChange={setCodingState}
              onRequestSwitchVersion={(targetVer) => applyVersionSwitch(targetVer)}
              onConfirmAction={(config) =>
                setConfirmDialog({
                  ...config,
                  actions: config.actions.map((act) => ({
                    ...act,
                    onClick: () => {
                      setConfirmDialog(null);
                      act.onClick();
                    },
                  })),
                })
              }
              onOpenDetail={({ level, code }) => {
                void loadDetail(level, code);
                setModule("detail");
              }}
            />
          </div>

          {module === "detail" && (
            <section className="module">
              {detailError && (
                <div className="coding-banner error" role="alert" style={{ marginBottom: 8 }}>
                  <span className="coding-banner-text">{detailError}</span>
                </div>
              )}
              <DetailWorkspace
                detail={detail}
                smqDetail={smqDetail}
                mode={mode}
                binKeys={binKeys}
                onBin={addToBin}
                onRemoveBin={removeFromBin}
                onCopy={copy}
                onExportSmq={exportSmq}
                onExportHierarchies={exportTermHierarchies}
                onOpen={loadDetail}
                onOpenSmq={loadSmqDetail}
              />
            </section>
          )}

          {module === "bin" && (
            <section className="module">
              <div className="query-bar">
                <input
                  value={binFilter}
                  onChange={(event) => setBinFilter(event.target.value)}
                  placeholder="筛选已收藏术语名称、级别或代码"
                  aria-label="筛选 Research Bin"
                />
                <button type="button" onClick={exportBin} disabled={!bin.length}>
                  <Download size={15} /> 导出JSON
                </button>
                <button
                  type="button"
                  onClick={() => downloadText("meddra_research_bin.csv", rowsToCsv(bin), "text/csv;charset=utf-8")}
                  disabled={!bin.length}
                >
                  <Download size={15} /> 导出CSV
                </button>
                <button type="button" onClick={() => importRef.current?.click()}>
                  <Upload size={15} /> 导入 Bin
                </button>
                <button
                  type="button"
                  disabled={!bin.length}
                  onClick={() => {
                    setConfirmDialog({
                      title: "清空 Research Bin？",
                      body: `确定要清空当前保存的 ${bin.length} 条收藏术语吗？`,
                      actions: [
                        { label: "取消", onClick: () => setConfirmDialog(null) },
                        {
                          label: "确认清空",
                          variant: "danger",
                          onClick: () => {
                            setConfirmDialog(null);
                            setBin([]);
                            flash("已清空 Research Bin");
                          },
                        },
                      ],
                    });
                  }}
                >
                  <Trash2 size={15} /> 清空
                </button>
                <input ref={importRef} type="file" accept=".json,.csv,text/csv" hidden onChange={importBin} />
              </div>
              {bin.length > 0 && (
                <div className="search-summary-bar">
                  <span>
                    已收藏 <strong>{bin.length}</strong> 条 · 当前显示 {filteredBinRows.length} 条（本地持久保存）
                  </span>
                </div>
              )}
              <ResultList
                results={filteredBinRows}
                mode={mode}
                activeKey={activeSelectionKey}
                onOpen={loadDetail}
                onBin={addToBin}
                onRemove={removeFromBin}
                binKeys={binKeys}
                binMode
                emptyText={bin.length ? "当前筛选下无匹配收藏项" : "Research Bin 为空，可在搜索或详情页点击加入。"}
              />
            </section>
          )}

          {module === "history" && (
            <section className="module">
              <div className="history-header">
                <h2>操作历史 ({historyRows.length})</h2>
                <button
                  type="button"
                  className="kz-btn"
                  disabled={!historyRows.length}
                  onClick={() => {
                    setHistoryRows([]);
                    flash("已清空历史记录");
                  }}
                >
                  <Trash2 size={14} /> 清空历史
                </button>
              </div>
              {!historyRows.length ? (
                <EmptyState text="暂无搜索或浏览历史记录" />
              ) : (
                <div className="history-list">
                  {historyRows.map((row, index) => (
                    <button
                      type="button"
                      key={`${row.at}-${index}`}
                      onClick={() => {
                        if (row.action.includes("搜索")) {
                          setQuery(row.text);
                          void performSearch(row.text);
                        } else if (row.level && row.code) {
                          void loadDetail(row.level, row.code);
                        }
                      }}
                    >
                      <span>{row.action}</span>
                      <strong>
                        {row.text}
                        {row.version ? ` · v${row.version}` : ""}
                      </strong>
                      <time>{row.at}</time>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {module === "settings" && (
            <section className="module settings-panel">
              {!status?.version && (
                <div className="dictionary-banner">
                  <strong>还没有绑定 MedDRA 词典</strong>
                  <span>
                    请点击下方“选择词典文件夹”，在 Windows 文件管理器或 Mac Finder 里选择你的 MedDRA 文件夹。选中上级文件夹也可以。
                  </span>
                </div>
              )}
              <div className="kz-thin" style={{ padding: "8px 12px" }}>
                <OptionsRow
                  includeSynonyms={includeSynonyms}
                  setIncludeSynonyms={setIncludeSynonyms}
                  ignoreDiacritics={ignoreDiacritics}
                  setIgnoreDiacritics={setIgnoreDiacritics}
                  includeNonCurrent={includeNonCurrent}
                  setIncludeNonCurrent={setIncludeNonCurrent}
                />
              </div>
              <div className="status-grid">
                <Metric label="SMQ数量" value={status?.smq_count ?? 0} />
                {status?.term_counts.map((row) => (
                  <Metric key={row.level} label={row.level} value={row.n} />
                ))}
              </div>
              <div className="source-import kz-card">
                <header>
                  <h2>绑定 MedDRA 词典文件夹</h2>
                  <p>
                    第一次使用时，点击“选择词典文件夹”。在 Windows 文件管理器或 Mac Finder 里选 MedDRA_29_0_Chinese、MedDRA_29_0_English、MedAscii/ascii-290，或它们的上级文件夹。系统会自己往下找。
                  </p>
                </header>
                <p className="source-help">
                  正常的 MedDRA 词典文件夹里会有下面这些文件。你不用逐个打开它们，只要选中它们所在的文件夹。
                </p>
                <div className="required-files">
                  {["soc.asc", "pt.asc", "llt.asc", "mdhier.asc", "smq_list.asc", "smq_content.asc"].map((file) => (
                    <code key={file}>{file}</code>
                  ))}
                </div>
                <div className="query-bar compact">
                  <button
                    type="button"
                    className="primary"
                    onClick={pickDictionarySource}
                    disabled={importingSource}
                  >
                    <Upload size={15} /> 选择词典文件夹
                  </button>
                  <input
                    value={sourcePath}
                    onChange={(event) => setSourcePath(event.target.value)}
                    placeholder="找不到选择窗口时，可把词典文件夹路径粘贴到这里"
                  />
                  <button type="button" onClick={addDictionarySourceFromPath} disabled={importingSource}>
                    手动加入路径
                  </button>
                  <button type="button" onClick={reindexCurrentVersion} disabled={importingSource || !version}>
                    <RotateCcw size={15} /> 重建当前版本
                  </button>
                </div>
              </div>

              <div className="source-import kz-card">
                <h2 className="settings-section-title">同义词表预览</h2>
                <div className="query-bar compact">
                  <button type="button" onClick={() => void loadSynonyms("zh")}>
                    查看中文同义词表
                  </button>
                  <button type="button" onClick={() => void loadSynonyms("en")}>
                    查看英文同义词表
                  </button>
                </div>
                {synonymStatus && <p className="synonym-status">{synonymStatus}</p>}
                {synonyms.length > 0 && (
                  <div className="synonym-list">
                    {synonyms.map((row) => (
                      <div key={`${row.lang}:${row.synonym_group}:${row.phrase}`}>
                        <strong>{row.phrase}</strong>
                        <span>{row.synonym_group}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="source-import kz-card" aria-label="已识别MedDRA版本">
                <h2 className="settings-section-title">已识别 MedDRA 版本 ({availableVersions.length})</h2>
                <div className="release-list">
                  {availableVersions.map((release) => {
                    const isCurrent = release.version === version;
                    return (
                      <div key={release.version} className={`release-list-row${isCurrent ? " is-active" : ""}`}>
                        <div className="release-list-meta">
                          <strong>MedDRA {release.version}</strong>
                          <span>{releaseLanguageLabel(release)}</span>
                        </div>
                        <button
                          type="button"
                          className="mini"
                          disabled={isCurrent}
                          onClick={() => requestVersionChange(release.version)}
                        >
                          {isCurrent ? "当前使用" : "切换"}
                        </button>
                      </div>
                    );
                  })}
                  {sourceRoots.some((root) => !root.exists) && (
                    <div className="release-list-row">
                      <strong>有词典文件夹不可读取</strong>
                      <span>请重新选择词典文件夹</span>
                    </div>
                  )}
                </div>
              </div>

              {canShutdownPortable && (
                <div className="portable-card kz-card">
                  <div>
                    <h2 className="settings-section-title">便携版服务控制</h2>
                    <p className="source-help">不用时点击“退出便携版”安全关闭本地后端，不留后台端口进程。</p>
                  </div>
                  <button
                    type="button"
                    className="portable-exit-btn"
                    disabled={shuttingDown}
                    onClick={requestPortableShutdown}
                  >
                    <Power size={14} /> 退出便携版
                  </button>
                </div>
              )}
            </section>
          )}
        </main>

        <div
          className="pane-resizer pane-resizer-right"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="调整右侧关系树宽度"
          aria-valuemin={MIN_RIGHT_PANE_WIDTH}
          aria-valuemax={MAX_RIGHT_PANE_WIDTH}
          aria-valuenow={paneWidths.right}
          onPointerDown={(event) => startPaneResize("right", event)}
          onKeyDown={(event) => handleResizerKeyDown("right", event)}
        />

        <aside className="right-pane">
          <RelationshipTreePanel
            detail={detail}
            smqDetail={smqDetail}
            mode={mode}
            onOpen={loadDetail}
            onOpenSmq={loadSmqDetail}
          />
        </aside>
      </div>

      {createPortal(<dialog
        ref={confirmDialogRef}
        className="kz-dialog kz-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        tabIndex={-1}
        onCancel={(event) => {
          event.preventDefault();
          setConfirmDialog(null);
        }}
      >
        {confirmDialog && (
          <div className="kz-dialog-frame">
            <header className="kz-dialog-head">
              <h2 id="confirm-dialog-title">{confirmDialog.title}</h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setConfirmDialog(null)}
                aria-label="关闭确认框"
              >
                <X size={15} />
              </button>
            </header>
            <div className="kz-dialog-body">
              <p style={{ margin: 0, lineHeight: 1.55 }}>{confirmDialog.body}</p>
              {confirmDialog.warning && (
                <div className="coding-banner warn" role="alert">
                  <span className="coding-banner-text">
                    <AlertTriangle size={14} /> {confirmDialog.warning}
                  </span>
                </div>
              )}
            </div>
            <footer className="kz-dialog-foot">
              {confirmDialog.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={`kz-btn${action.variant === "primary" ? " primary" : action.variant === "danger" ? " danger" : ""}`}
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
            </footer>
          </div>
        )}
      </dialog>, document.body)}

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-dot" aria-hidden="true" />
          {toast}
        </div>
      )}
    </div>
  );
}

function IndexProgressPanel({
  status,
  visible,
  onRetry,
  onOpenSettings,
}: {
  status: IndexStatus | null;
  visible: boolean;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  if (!visible || !status) {
    return <div className="index-progress-panel is-hidden" aria-hidden="true" />;
  }
  const percent = indexPercent(status);
  const rows = status.total_rows
    ? `${formatInteger(status.processed_rows)} / ${formatInteger(status.total_rows)} 条处理记录`
    : "正在统计处理记录";
  const label = status.state === "error" ? "索引失败" : status.state === "ready" ? "索引完成" : "正在建立本地索引";
  return (
    <section className={`index-progress-panel state-${status.state}`} aria-live="polite">
      <div className="index-progress-copy">
        <strong>{label}</strong>
        <span>
          MedDRA {status.version || "本地词典"} · {status.error || status.message || "准备中"}
        </span>
        <em>{rows}</em>
      </div>
      <div
        className="index-progress-meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <b>{percent}%</b>
      {status.state === "error" && (
        <div className="index-progress-actions">
          <button type="button" className="kz-btn primary" onClick={onRetry}>
            <RotateCcw size={13} /> 重试建索引
          </button>
          <button type="button" className="kz-btn" onClick={onOpenSettings}>
            打开设置
          </button>
        </div>
      )}
    </section>
  );
}

function TreeRow({
  node,
  depth,
  treeTab,
  mode,
  activeKey,
  expanded,
  onExpand,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  treeTab: "soc" | "smq";
  mode: Mode;
  activeKey: string;
  expanded: Record<string, TreeNode[]>;
  onExpand: (node: TreeNode) => void;
  onOpen: (node: TreeNode) => void;
}) {
  const code = node.code || node.smq_code || "";
  const key = `${treeTab}:${node.level}:${code}`;
  const children = expanded[key];
  const nodeTitle = displayName(node, mode) || node.display_name;
  const isSelected = activeKey === `${node.level}:${code}`;
  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: `${depth * 14 + 4}px` }}>
        <button
          type="button"
          className="tree-toggle"
          onClick={() => node.has_children !== false && onExpand(node)}
          title={children ? "收起" : "展开"}
          aria-expanded={Boolean(children)}
          aria-label={`${children ? "收起" : "展开"} ${nodeTitle}`}
        >
          <ChevronRight size={13} className={children ? "rotated" : ""} />
        </button>
        <button
          type="button"
          className={`tree-label${isSelected ? " is-selected" : ""}`}
          onClick={() => onOpen(node)}
          title={`${nodeTitle} · ${code}`}
        >
          <span className={`level-badge level-${node.level}`}>{node.level}</span>
          <strong>{nodeTitle}</strong>
          <em>{code}</em>
        </button>
      </div>
      {children?.map((child) => (
        <TreeRow
          key={`${key}:${child.code || child.smq_code}`}
          node={child}
          depth={depth + 1}
          treeTab={treeTab}
          mode={mode}
          activeKey={activeKey}
          expanded={expanded}
          onExpand={onExpand}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function LevelFilter({
  selectedLevels,
  onToggle,
}: {
  selectedLevels: SearchLevel[];
  onToggle: (level: SearchLevel) => void;
}) {
  return (
    <div className="level-filter" aria-label="搜索层级筛选">
      <span>搜索层级</span>
      <div>
        {LEVEL_OPTIONS.map((item) => {
          const active = selectedLevels.includes(item.key);
          return (
            <button
              type="button"
              key={item.key}
              className={active ? `active level-${item.key}` : ""}
              onClick={() => onToggle(item.key)}
            >
              {active && <Check size={12} />}
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OptionsRow(props: {
  includeSynonyms: boolean;
  setIncludeSynonyms: (value: boolean) => void;
  ignoreDiacritics: boolean;
  setIgnoreDiacritics: (value: boolean) => void;
  includeNonCurrent: boolean;
  setIncludeNonCurrent: (value: boolean) => void;
}) {
  return (
    <div className="options-row">
      <label>
        <input
          type="checkbox"
          checked={props.includeSynonyms}
          onChange={(event) => props.setIncludeSynonyms(event.target.checked)}
        />{" "}
        使用同义词表
      </label>
      <label>
        <input
          type="checkbox"
          checked={props.ignoreDiacritics}
          onChange={(event) => props.setIgnoreDiacritics(event.target.checked)}
        />{" "}
        忽略变音符号
      </label>
      <label>
        <input
          type="checkbox"
          checked={props.includeNonCurrent}
          onChange={(event) => props.setIncludeNonCurrent(event.target.checked)}
        />{" "}
        显示非当前LLT/非活动SMQ条目
      </label>
    </div>
  );
}

function SearchGroups({
  groups,
  mode,
  activeKey,
  onOpen,
  onBin,
  onRemove,
  binKeys,
}: {
  groups: SearchGroup[];
  mode: Mode;
  activeKey: string;
  onOpen: (level: string, code: string) => void;
  onBin: (result: SearchResult) => void;
  onRemove: (result: SearchResult) => void;
  binKeys: Set<string>;
}) {
  const [groupPages, setGroupPages] = useState<Record<string, number>>({});
  const GROUP_PAGE_SIZE = 30;

  if (!groups.length) {
    return <EmptyState text="输入术语、中文/英文片段或 MedDRA 代码后按 Enter 或点击搜索。" />;
  }
  return (
    <div className="group-stack">
      {groups.map((group) => {
        const total = group.results.length;
        const totalPages = Math.max(1, Math.ceil(total / GROUP_PAGE_SIZE));
        const currentPage = Math.min(groupPages[group.category] || 1, totalPages);
        const start = (currentPage - 1) * GROUP_PAGE_SIZE;
        const slice = group.results.slice(start, start + GROUP_PAGE_SIZE);
        return (
          <section className="result-group" key={group.category}>
            <header>
              <h2>{group.label}</h2>
              <div className="section-header-tools">
                {totalPages > 1 && (
                  <>
                    <button
                      type="button"
                      className="mini"
                      disabled={currentPage <= 1}
                      onClick={() =>
                        setGroupPages((prev) => ({ ...prev, [group.category]: Math.max(1, currentPage - 1) }))
                      }
                    >
                      上一页
                    </button>
                    <span className="verbatim-sub">
                      {start + 1}–{Math.min(start + GROUP_PAGE_SIZE, total)} / {total}
                    </span>
                    <button
                      type="button"
                      className="mini"
                      disabled={currentPage >= totalPages}
                      onClick={() =>
                        setGroupPages((prev) => ({ ...prev, [group.category]: Math.min(totalPages, currentPage + 1) }))
                      }
                    >
                      下一页
                    </button>
                  </>
                )}
                <span>{group.total_count ?? group.count} 条</span>
              </div>
            </header>
            <ResultList
              results={slice}
              mode={mode}
              activeKey={activeKey}
              onOpen={onOpen}
              onBin={onBin}
              onRemove={onRemove}
              binKeys={binKeys}
            />
          </section>
        );
      })}
    </div>
  );
}

function ResultList({
  results,
  mode,
  activeKey,
  onOpen,
  onBin,
  onRemove,
  binKeys,
  binMode = false,
  emptyText = "暂无结果",
}: {
  results: SearchResult[];
  mode: Mode;
  activeKey?: string;
  onOpen: (level: string, code: string) => void;
  onBin: (result: SearchResult) => void;
  onRemove?: (result: SearchResult) => void;
  binKeys: Set<string>;
  binMode?: boolean;
  emptyText?: string;
}) {
  if (!results.length) return <EmptyState text={emptyText} />;
  return (
    <div className="result-list">
      {results.map((result, index) => {
        const inBin = binKeys.has(`${result.level}:${result.code}`);
        const selected = activeKey === `${result.level}:${result.code}`;
        const primaryTitle =
          mode === "en"
            ? result.en_name || result.zh_name
            : result.zh_name || result.en_name;
        const secondarySubtitle =
          mode === "both" && result.en_name && result.zh_name && result.en_name !== result.zh_name
            ? result.en_name
            : "";

        return (
          <article
            className={[
              "result",
              result.category === "fuzzy" ? "fuzzy" : "",
              selected ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={`${result.level}:${result.code}:${index}`}
          >
            <button type="button" className="result-main" onClick={() => onOpen(result.level, result.code)}>
              <span className={`level-badge level-${result.level}`}>{result.level}</span>
              <strong>{primaryTitle}</strong>
              {secondarySubtitle && <small>{secondarySubtitle}</small>}
              <em>{result.code}</em>
            </button>
            <div className="result-meta">
              <span>{result.category_label}</span>
              <span>
                {result.matched_field}
                {result.level === "LLT" && result.is_current === "N" ? " · 非当前LLT" : ""}
              </span>
              <p>{result.reason}</p>
            </div>
            <div className="result-actions">
              {binMode ? (
                <button
                  type="button"
                  className="danger-action"
                  title="从Research Bin移除"
                  onClick={() => onRemove?.(result)}
                >
                  <Trash2 size={14} />
                  移除
                </button>
              ) : inBin ? (
                <>
                  <button type="button" className="bin-state" title="已加入Research Bin" disabled>
                    <Check size={14} />
                    已加入
                  </button>
                  {onRemove && (
                    <button type="button" title="从Research Bin移除" onClick={() => onRemove(result)}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </>
              ) : (
                <button type="button" title="加入Research Bin" onClick={() => onBin(result)}>
                  <Clipboard size={14} />
                  加入
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function DetailWorkspace({
  detail,
  smqDetail,
  mode,
  binKeys,
  onBin,
  onRemoveBin,
  onCopy,
  onExportSmq,
  onExportHierarchies,
  onOpen,
  onOpenSmq,
}: {
  detail: Detail | null;
  smqDetail: SmqDetail | null;
  mode: Mode;
  binKeys: Set<string>;
  onBin: (result: SearchResult) => void;
  onRemoveBin: (result: SearchResult) => void;
  onCopy: (text: string) => void;
  onExportSmq: () => void;
  onExportHierarchies: () => void;
  onOpen: (level: string, code: string) => void;
  onOpenSmq: (code: string) => void;
}) {
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [detailPage, setDetailPage] = useState(1);
  const DETAIL_PAGE_SIZE = 50;

  const activeDetailId = smqDetail?.smq
    ? `SMQ:${smqDetail.smq.smq_code}`
    : detail?.term
      ? `${detail.term.level}:${detail.term.code}`
      : "";

  useEffect(() => {
    setScopeFilter("all");
    setDetailPage(1);
  }, [activeDetailId]);

  useEffect(() => {
    setDetailPage(1);
  }, [scopeFilter]);

  if (smqDetail?.smq) {
    const smq = smqDetail.smq;
    const smqCode = smq.smq_code || smq.code || "";
    const content = smqDetail.relationships?.content || smqDetail.content || [];
    const narrowCount = content.filter((r) => r.scope === "2").length;
    const broadCount = content.filter((r) => r.scope === "1").length;
    const childSmqCount = content.filter((r) => r.scope === "0").length;
    const filteredContent =
      scopeFilter === "all" ? content : content.filter((row) => String(row.scope) === scopeFilter);
    const totalPages = Math.max(1, Math.ceil(filteredContent.length / DETAIL_PAGE_SIZE));
    const clampedPage = Math.min(detailPage, totalPages);
    const pagedContent = filteredContent.slice(
      (clampedPage - 1) * DETAIL_PAGE_SIZE,
      clampedPage * DETAIL_PAGE_SIZE
    );
    const inBin = binKeys.has(`SMQ:${smqCode}`);

    return (
      <div className="detail-workspace">
        <header className="detail-hero kz-card">
          <span className="level-badge level-SMQ">SMQ</span>
          <div>
            <h2>{displayName(smq, mode)}</h2>
            <p>{smqCode}</p>
          </div>
          <div className="detail-actions">
            <button type="button" onClick={() => onCopy(smqCode)}>
              <Clipboard size={14} /> 复制代码
            </button>
            <button type="button" onClick={onExportSmq}>
              <Download size={14} /> 导出SMQ
            </button>
            <button
              type="button"
              onClick={() =>
                inBin
                  ? onRemoveBin({
                      level: "SMQ",
                      level_label: "SMQ",
                      code: smqCode,
                      en_name: smq.en_name || "",
                      zh_name: smq.zh_name || "",
                      is_current: smq.status || "",
                      category: "smq",
                      category_label: "SMQ",
                      matched_field: "SMQ详情",
                      score: 100,
                      reason: "从详情加入",
                    })
                  : onBin({
                      level: "SMQ",
                      level_label: "SMQ",
                      code: smqCode,
                      en_name: smq.en_name || "",
                      zh_name: smq.zh_name || "",
                      is_current: smq.status || "",
                      category: "smq",
                      category_label: "SMQ",
                      matched_field: "SMQ详情",
                      score: 100,
                      reason: "从详情加入",
                    })
              }
            >
              {inBin ? <Check size={14} /> : <Clipboard size={14} />} {inBin ? "已在 Bin" : "加入 Bin"}
            </button>
          </div>
        </header>

        <div className="analysis-strip kz-thin">
          <div className="analysis-stat">
            <span>包含总数</span>
            <strong>{content.length}</strong>
          </div>
          <div className="analysis-stat">
            <span>狭义 (Narrow)</span>
            <strong>{narrowCount}</strong>
          </div>
          <div className="analysis-stat">
            <span>广义 (Broad)</span>
            <strong>{broadCount}</strong>
          </div>
          <div className="analysis-stat">
            <span>子级 SMQ</span>
            <strong>{childSmqCount}</strong>
          </div>
        </div>

        <section className="relationship-section">
          <h3>SMQ说明</h3>
          <p>{mode === "en" ? smq.en_description || "No description" : smq.zh_description || smq.en_description || "无说明"}</p>
        </section>

        <section className="relationship-section">
          <h3>
            <span>
              包含术语 ({filteredContent.length} / {content.length})
            </span>
            <div className="section-header-tools">
              <div className="scope-pills">
                {[
                  { key: "all", label: "全部" },
                  { key: "2", label: `狭义(${narrowCount})` },
                  { key: "1", label: `广义(${broadCount})` },
                  { key: "0", label: `子SMQ(${childSmqCount})` },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={scopeFilter === opt.key ? "active" : ""}
                    onClick={() => setScopeFilter(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {totalPages > 1 && (
                <>
                  <button
                    type="button"
                    className="mini"
                    disabled={clampedPage <= 1}
                    onClick={() => setDetailPage((p) => Math.max(1, p - 1))}
                  >
                    上一页
                  </button>
                  <span className="verbatim-sub">
                    {clampedPage}/{totalPages}
                  </span>
                  <button
                    type="button"
                    className="mini"
                    disabled={clampedPage >= totalPages}
                    onClick={() => setDetailPage((p) => Math.min(totalPages, p + 1))}
                  >
                    下一页
                  </button>
                </>
              )}
            </div>
          </h3>
          <div className="wide-table">
            {pagedContent.map((row) => (
              <button
                type="button"
                key={`${row.term_code}-${row.scope}-${row.term_level}`}
                onClick={() => onOpen(String(row.term_level || "PT"), String(row.term_code))}
              >
                <span className={`level-badge level-${row.term_level}`}>{row.term_level}</span>
                <strong>{displayName({ en_name: row.en_name, zh_name: row.zh_name }, mode)}</strong>
                <em>{row.term_code}</em>
                <small>
                  {row.scope_label} · {row.status_label}
                </small>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  if (!detail?.term) {
    return <EmptyState text="从搜索结果、SOC层级或SMQ层级打开一个条目后，这里会显示完整上下游关系与分析摘要。" />;
  }

  const term = detail.term;
  const relationships = detail.relationships || {};
  const paths = relationships.hierarchy_paths || detail.hierarchies || [];
  const dedupedPaths = dedupeHierarchyPaths(paths, term.level);
  const memberships = relationships.smq_memberships || detail.smq_memberships || [];
  const primaryPath = dedupedPaths.find((r) => r.primary_soc === "Y") || dedupedPaths[0];
  const primarySocLabel = primaryPath ? hierarchyName(primaryPath, "soc", mode) : "—";
  const narrowSmqCount = memberships.filter((r) => r.scope === "2").length;
  const broadSmqCount = memberships.filter((r) => r.scope === "1").length;
  const currentText = term.level === "LLT" ? (term.is_current === "Y" ? "当前LLT" : "非当前LLT") : "当前术语";
  const inBin = binKeys.has(`${term.level}:${term.code}`);

  const filteredMemberships =
    scopeFilter === "all" ? memberships : memberships.filter((row) => String(row.scope) === scopeFilter);
  const memTotalPages = Math.max(1, Math.ceil(filteredMemberships.length / DETAIL_PAGE_SIZE));
  const clampedMemPage = Math.min(detailPage, memTotalPages);
  const pagedMemberships = filteredMemberships.slice(
    (clampedMemPage - 1) * DETAIL_PAGE_SIZE,
    clampedMemPage * DETAIL_PAGE_SIZE
  );

  return (
    <div className="detail-workspace">
      <header className="detail-hero kz-card">
        <span className={`level-badge level-${term.level}`}>{term.level}</span>
        <div>
          <h2>{displayName(term, mode)}</h2>
          <p>
            {term.code} · {currentText}
          </p>
        </div>
        <div className="detail-actions">
          <button type="button" onClick={() => onCopy(term.code)}>
            <Clipboard size={14} /> 复制代码
          </button>
          <button type="button" onClick={() => onCopy(displayName(term, mode))}>
            <Clipboard size={14} /> 复制术语
          </button>
          <button
            type="button"
            onClick={() =>
              inBin
                ? onRemoveBin({
                    level: term.level,
                    level_label: term.level,
                    code: term.code,
                    en_name: term.en_name,
                    zh_name: term.zh_name,
                    is_current: term.is_current,
                    category: "detail",
                    category_label: "详情",
                    matched_field: "详情页",
                    score: 100,
                    reason: "从详情页加入",
                  })
                : onBin({
                    level: term.level,
                    level_label: term.level,
                    code: term.code,
                    en_name: term.en_name,
                    zh_name: term.zh_name,
                    is_current: term.is_current,
                    category: "detail",
                    category_label: "详情",
                    matched_field: "详情页",
                    score: 100,
                    reason: "从详情页加入",
                  })
            }
          >
            {inBin ? <Check size={14} /> : <Clipboard size={14} />} {inBin ? "已在 Bin" : "加入 Bin"}
          </button>
        </div>
      </header>

      <div className="analysis-strip kz-thin" aria-label="术语分析摘要">
        <div className="analysis-stat">
          <span>主 SOC</span>
          <strong title={primarySocLabel}>{primarySocLabel}</strong>
        </div>
        <div className="analysis-stat">
          <span>层级路径数</span>
          <strong>{dedupedPaths.length}</strong>
        </div>
        <div className="analysis-stat">
          <span>直接子级</span>
          <strong>{detail.children_count ?? relationships.children?.length ?? 0}</strong>
        </div>
        <div className="analysis-stat">
          <span>狭义 / 广义 SMQ</span>
          <strong>
            {narrowSmqCount} / {broadSmqCount}
          </strong>
        </div>
      </div>

      <section className="relationship-section">
        <h3>
          <span>父系层级路径 ({dedupedPaths.length})</span>
          {dedupedPaths.length > 0 && (
            <button type="button" className="mini" onClick={onExportHierarchies}>
              <Download size={12} /> 导出路径CSV
            </button>
          )}
        </h3>
        <div className="path-lanes">
          {dedupedPaths.map((row, index) => (
            <div className="path-lane" key={`${row.path_key}-${index}`}>
              <b>{row.primary_soc === "Y" ? "主SOC" : "次SOC"}</b>
              {hierarchySegments(row, term.level, mode, displayName(term, mode), term.code).map(
                (segment, segmentIndex) => (
                  <button
                    type="button"
                    className={`path-segment-btn${segment.level === term.level ? " current-path-node" : ""}`}
                    key={`${segment.level}:${segment.code || segment.name}`}
                    onClick={() => segment.code && onOpen(segment.level, segment.code)}
                  >
                    {segmentIndex > 0 && <ChevronRight size={13} />}
                    <strong>{segment.level}</strong>
                    {segment.name}
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="relationship-section">
        <h3>
          <span>
            SMQ成员关系 ({filteredMemberships.length} / {memberships.length})
          </span>
          <div className="section-header-tools">
            <div className="scope-pills">
              {[
                { key: "all", label: "全部" },
                { key: "2", label: `狭义(${narrowSmqCount})` },
                { key: "1", label: `广义(${broadSmqCount})` },
              ].map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={scopeFilter === opt.key ? "active" : ""}
                  onClick={() => setScopeFilter(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {memTotalPages > 1 && (
              <>
                <button
                  type="button"
                  className="mini"
                  disabled={clampedMemPage <= 1}
                  onClick={() => setDetailPage((p) => Math.max(1, p - 1))}
                >
                  上一页
                </button>
                <span className="verbatim-sub">
                  {clampedMemPage}/{memTotalPages}
                </span>
                <button
                  type="button"
                  className="mini"
                  disabled={clampedMemPage >= memTotalPages}
                  onClick={() => setDetailPage((p) => Math.min(memTotalPages, p + 1))}
                >
                  下一页
                </button>
              </>
            )}
          </div>
        </h3>
        {!pagedMemberships.length ? (
          <p className="verbatim-sub">当前筛选下无所属 SMQ 记录。</p>
        ) : (
          <div className="wide-table">
            {pagedMemberships.map((row) => (
              <button
                type="button"
                key={`${row.smq_code}-${row.term_code}-${row.scope}`}
                onClick={() => onOpenSmq(String(row.smq_code))}
              >
                <span className="level-badge level-SMQ">SMQ</span>
                <strong>{displayName({ en_name: row.smq_en_name, zh_name: row.smq_zh_name }, mode)}</strong>
                <em>{row.smq_code}</em>
                <small>
                  {row.scope_label} · {row.status_label}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RelationshipTreePanel({
  detail,
  smqDetail,
  mode,
  onOpen,
  onOpenSmq,
}: {
  detail: Detail | null;
  smqDetail: SmqDetail | null;
  mode: Mode;
  onOpen: (level: string, code: string) => void;
  onOpenSmq: (code: string) => void;
}) {
  const activeKey = smqDetail?.smq
    ? `SMQ:${smqDetail.smq.smq_code || smqDetail.smq.code}`
    : detail?.term
      ? `${detail.term.level}:${detail.term.code}`
      : "empty";
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => ({
    "term-children:0": true,
    "smq-content": true,
    "smq-children": false,
  }));

  useEffect(() => {
    setOpenGroups({
      "term-children:0": true,
      "smq-content": true,
      "smq-children": false,
    });
  }, [activeKey]);

  const toggleGroup = (key: string) => {
    setOpenGroups((current) => ({ ...current, [key]: !current[key] }));
  };

  if (smqDetail?.smq) {
    const smq = smqDetail.smq;
    const parents = smqDetail.parents || [];
    const children = smqDetail.children || [];
    const content = smqDetail.relationships?.content || smqDetail.content || [];
    const currentNode = smqTreeNode(smq, mode, true);
    const currentDepth = parents.length ? 1 : 0;

    return (
      <div className="relationship-tree-panel">
        <header>
          <span>关系树</span>
          <h2>{displayName(smq, mode)}</h2>
          <p>{smq.smq_code || smq.code}</p>
        </header>
        <div className="relation-tree-scroll">
          {parents.length ? (
            parents.map((parent, index) => (
              <div className="relation-tree-branch" key={`smq-parent:${parent.smq_code || parent.code}:${index}`}>
                <div className="relation-tree-path-label">SMQ父级路径 {index + 1}</div>
                <RelationshipTreeNodeRow
                  node={smqTreeNode(parent, mode)}
                  depth={0}
                  onClick={() => onOpenSmq(parent.smq_code || parent.code || "")}
                />
                <RelationshipTreeNodeRow
                  node={currentNode}
                  depth={1}
                  onClick={() => onOpenSmq(smq.smq_code || smq.code || "")}
                />
                <CollapsedTreeGroup
                  groupKey={`smq-children:${index}`}
                  title="下级SMQ"
                  nodes={children.map((child) => smqTreeNode(child, mode))}
                  depth={2}
                  open={Boolean(openGroups[`smq-children:${index}`])}
                  onToggle={toggleGroup}
                  onOpenNode={(node) => onOpenSmq(node.code)}
                />
                <CollapsedTreeGroup
                  groupKey={`smq-content:${index}`}
                  title="包含术语"
                  nodes={content.map((row) => smqContentTreeNode(row, mode))}
                  depth={2}
                  open={Boolean(openGroups[`smq-content:${index}`])}
                  onToggle={toggleGroup}
                  onOpenNode={(node) => onOpen(node.level, node.code)}
                />
              </div>
            ))
          ) : (
            <div className="relation-tree-branch">
              <div className="relation-tree-path-label">SMQ当前节点</div>
              <RelationshipTreeNodeRow
                node={currentNode}
                depth={0}
                onClick={() => onOpenSmq(smq.smq_code || smq.code || "")}
              />
              <CollapsedTreeGroup
                groupKey="smq-children"
                title="下级SMQ"
                nodes={children.map((child) => smqTreeNode(child, mode))}
                depth={currentDepth + 1}
                open={Boolean(openGroups["smq-children"])}
                onToggle={toggleGroup}
                onOpenNode={(node) => onOpenSmq(node.code)}
              />
              <CollapsedTreeGroup
                groupKey="smq-content"
                title="包含术语"
                nodes={content.map((row) => smqContentTreeNode(row, mode))}
                depth={currentDepth + 1}
                open={Boolean(openGroups["smq-content"])}
                onToggle={toggleGroup}
                onOpenNode={(node) => onOpen(node.level, node.code)}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!detail?.term) {
    return (
      <div className="relationship-tree-panel">
        <header>
          <span>关系树</span>
          <h2>未选择条目</h2>
          <p>LLT / PT / HLT / HLGT / SOC / SMQ</p>
        </header>
        <EmptyState text="选择术语或SMQ后显示父级路径、当前节点和折叠子级。" />
      </div>
    );
  }

  const term = detail.term;
  const relationships = detail.relationships || {};
  const paths = dedupeHierarchyPaths(relationships.hierarchy_paths || detail.hierarchies || [], term.level);
  const children = relationships.children || [];
  const selectedName = displayName(term, mode);
  const branches = paths.length ? paths : [{ primary_soc: "", path_key: `${term.level}:${term.code}` }];

  return (
    <div className="relationship-tree-panel">
      <header>
        <span>关系树</span>
        <h2>{selectedName}</h2>
        <p>
          {term.level} · {term.code}
        </p>
      </header>
      <div className="relation-tree-scroll">
        {branches.map((row, index) => {
          const segments = paths.length
            ? hierarchySegments(row, term.level, mode, selectedName, term.code)
            : [{ level: term.level, code: term.code, name: selectedName }];
          const childDepth = Math.max(1, segments.length);
          const groupKey = `term-children:${index}`;
          return (
            <div className="relation-tree-branch" key={`${row.path_key || index}`}>
              <div className="relation-tree-path-label">
                {row.primary_soc === "Y" ? "主SOC路径" : row.primary_soc === "N" ? "次SOC路径" : "当前节点"}{" "}
                {paths.length > 1 ? index + 1 : ""}
              </div>
              {segments.map((segment, segmentIndex) => {
                const isCurrent = segment.level === term.level;
                return (
                  <RelationshipTreeNodeRow
                    key={`${segment.level}:${segment.code || segment.name}:${segmentIndex}`}
                    node={{
                      level: segment.level,
                      levelLabel: segment.level,
                      code: isCurrent ? term.code : segment.code,
                      name: segment.name,
                      current: isCurrent,
                      inactive: isCurrent && term.level === "LLT" && term.is_current !== "Y",
                      meta: isCurrent ? currentTermMeta(term) : undefined,
                    }}
                    depth={segmentIndex}
                    onClick={() => onOpen(segment.level, isCurrent ? term.code : segment.code)}
                  />
                );
              })}
              <CollapsedTreeGroup
                groupKey={groupKey}
                title="直接子级"
                nodes={children.map((child) => relationTreeNode(child, mode))}
                depth={childDepth}
                open={Boolean(openGroups[groupKey])}
                onToggle={toggleGroup}
                onOpenNode={(node) => onOpen(node.level, node.code)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RelationshipTreeNodeRow({
  node,
  depth,
  onClick,
}: {
  node: RelationshipTreeNode;
  depth: number;
  onClick?: () => void;
}) {
  const className = [
    "relationship-tree-node",
    node.current ? "current" : "",
    node.inactive ? "inactive" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      <span className={`level-badge level-${node.level}`}>{node.levelLabel || node.level}</span>
      <strong>{node.name}</strong>
      <em>{node.code}</em>
      {(node.meta || node.current || node.inactive) && (
        <small>
          {node.current && <b>当前选中</b>}
          {node.inactive && <b>非当前</b>}
          {node.meta}
        </small>
      )}
    </>
  );

  if (!onClick || !node.code) {
    return (
      <div className={className} style={depthStyle(depth)}>
        {content}
      </div>
    );
  }

  return (
    <button type="button" className={className} style={depthStyle(depth)} onClick={onClick}>
      {content}
    </button>
  );
}

function CollapsedTreeGroup({
  groupKey,
  title,
  nodes,
  depth,
  open,
  onToggle,
  onOpenNode,
}: {
  groupKey: string;
  title: string;
  nodes: RelationshipTreeNode[];
  depth: number;
  open: boolean;
  onToggle: (key: string) => void;
  onOpenNode: (node: RelationshipTreeNode) => void;
}) {
  return (
    <div className="relationship-tree-group">
      <button
        type="button"
        className={`relationship-tree-toggle${open ? " open rotated" : ""}`}
        style={depthStyle(depth)}
        aria-expanded={open}
        onClick={() => onToggle(groupKey)}
      >
        <ChevronRight size={13} className={open ? "rotated" : ""} />
        <span>{title}</span>
        <strong>{nodes.length}</strong>
      </button>
      {open && (
        <div className="relationship-tree-children">
          {nodes.length ? (
            nodes.map((node, index) => (
              <RelationshipTreeNodeRow
                key={`${groupKey}:${node.level}:${node.code}:${index}`}
                node={node}
                depth={depth + 1}
                onClick={() => onOpenNode(node)}
              />
            ))
          ) : (
            <div className="relationship-tree-empty" style={depthStyle(depth + 1)}>
              无直接子级
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function relationTreeNode(node: RelationNode, mode: Mode): RelationshipTreeNode {
  return {
    level: node.level,
    levelLabel: node.level,
    code: node.code,
    name: displayName(node, mode),
    inactive: node.level === "LLT" && node.is_current === "N",
    meta: node.children_count ? `${node.children_count.toLocaleString("zh-CN")} 个子级` : undefined,
  };
}

function smqTreeNode(node: TreeNode & { status?: string }, mode: Mode, current = false): RelationshipTreeNode {
  return {
    level: "SMQ",
    levelLabel: "SMQ",
    code: node.smq_code || node.code || "",
    name: displayName(node, mode),
    current,
    inactive: node.status === "I",
    meta: node.smq_level ? `层级 ${node.smq_level}` : undefined,
  };
}

function smqContentTreeNode(row: Record<string, string>, mode: Mode): RelationshipTreeNode {
  const name = displayName({ en_name: row.en_name, zh_name: row.zh_name }, mode);
  return {
    level: row.term_level || "PT",
    levelLabel: row.term_level || "PT",
    code: row.term_code || "",
    name,
    inactive: row.status === "I",
    meta: [row.scope_label, row.status_label].filter(Boolean).join(" · "),
  };
}

function currentTermMeta(term: NonNullable<Detail["term"]>) {
  if (term.level !== "LLT") return undefined;
  return term.is_current === "Y" ? "当前LLT" : "非当前LLT";
}

function depthStyle(depth: number) {
  return { "--tree-depth": depth } as CSSProperties;
}

function hierarchyName(row: Record<string, string>, level: "soc" | "hlgt" | "hlt" | "pt", mode: Mode) {
  const en = row[`en_${level}_name`] || "";
  const zh = row[`zh_${level}_name`] || "";
  return displayName({ en_name: en, zh_name: zh }, mode);
}

function dedupeHierarchyPaths(rows: Array<Record<string, string>>, selectedLevel: string) {
  const stopAt = selectedLevel === "LLT" ? "PT" : selectedLevel;
  const fieldsByLevel: Record<string, string[]> = {
    SOC: ["soc_code"],
    HLGT: ["soc_code", "hlgt_code"],
    HLT: ["soc_code", "hlgt_code", "hlt_code"],
    PT: ["soc_code", "hlgt_code", "hlt_code", "pt_code"],
  };
  const fields = fieldsByLevel[stopAt] || fieldsByLevel.PT;
  const seen = new Set<string>();
  const deduped: Array<Record<string, string>> = [];
  for (const row of rows) {
    const key = fields.map((field) => row[field] || "").join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...row, path_key: key });
  }
  return deduped;
}

function hierarchySegments(
  row: Record<string, string>,
  selectedLevel: string,
  mode: Mode,
  selectedName: string,
  selectedCode = ""
) {
  const levels: Array<"SOC" | "HLGT" | "HLT" | "PT"> = ["SOC", "HLGT", "HLT", "PT"];
  const stopAt = selectedLevel === "LLT" ? "PT" : selectedLevel;
  const stopIndex = Math.max(0, levels.indexOf(stopAt as "SOC" | "HLGT" | "HLT" | "PT"));
  const base: Array<{ level: string; code: string; name: string }> = levels.slice(0, stopIndex + 1).map((level) => ({
    level,
    code: row[`${level.toLowerCase()}_code`],
    name: hierarchyName(row, level.toLowerCase() as "soc" | "hlgt" | "hlt" | "pt", mode),
  }));
  if (selectedLevel === "LLT") {
    base.push({ level: "LLT", code: selectedCode, name: selectedName });
  }
  return base;
}

function releaseLanguageLabel(release: ReleaseInfo) {
  const langs = release.available_languages || [];
  if (langs.includes("en") && langs.includes("zh")) return "双语";
  if (langs.includes("zh")) return "仅中文";
  if (langs.includes("en")) return "仅英文";
  if (release.complete) return "双语";
  return `缺少 ${release.missing_languages.join(", ")}`;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString("zh-CN")}</strong>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function detailToResult(detail: Detail): SearchResult | null {
  if (!detail.term) return null;
  return {
    level: detail.term.level,
    level_label: detail.term.level,
    code: detail.term.code,
    en_name: detail.term.en_name,
    zh_name: detail.term.zh_name,
    is_current: detail.term.is_current,
    category: "code",
    category_label: "代码匹配",
    matched_field: "代码",
    score: 100,
    reason: "代码匹配结果",
  };
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    if (Array.isArray(fallback)) {
      return Array.isArray(value) && value.every((item) => item != null && typeof item === "object")
        ? (value as T)
        : fallback;
    }
    return value && Number.isFinite(value.left) && Number.isFinite(value.right) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The current app session remains usable if the browser disables storage.
  }
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function splitCsvLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function normalizeBinRow(row: Partial<SearchResult>): SearchResult | null {
  if (!row.code || !row.level) return null;
  return {
    level: String(row.level),
    level_label: String(row.level),
    code: String(row.code),
    en_name: String(row.en_name || ""),
    zh_name: String(row.zh_name || ""),
    is_current: String(row.is_current || ""),
    category: String(row.category || "import"),
    category_label: String(row.category_label || "导入"),
    matched_field: String(row.matched_field || "Research Bin"),
    score: Number(row.score || 0),
    reason: String(row.reason || "Research Bin导入"),
  };
}
