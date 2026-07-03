import {
  ChevronRight,
  Clipboard,
  Download,
  Check,
  History,
  Languages,
  Layers,
  ListTree,
  RotateCcw,
  Search,
  Settings,
  Square,
  SlidersHorizontal,
  Trash2,
  Upload
} from "lucide-react";
import { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

type Mode = "zh" | "en" | "both";
type ModuleKey = "search" | "advanced" | "detail" | "bin" | "history" | "settings";
type SearchLevel = "SOC" | "HLGT" | "HLT" | "PT" | "LLT" | "SMQ";
type PaneSide = "left" | "right";

interface SearchResult {
  level: string;
  level_label: string;
  code: string;
  en_name: string;
  zh_name: string;
  is_current: string;
  category: string;
  category_label: string;
  matched_field: string;
  score: number;
  reason: string;
}

interface SearchGroup {
  category: string;
  label: string;
  results: SearchResult[];
  count: number;
}

interface TreeNode {
  level: string;
  level_label?: string;
  code?: string;
  smq_code?: string;
  display_name: string;
  en_name: string;
  zh_name: string;
  has_children?: boolean;
  is_current?: string;
  smq_level?: string;
}

interface Detail {
  found: boolean;
  level?: string;
  code?: string;
  term?: {
    level: string;
    code: string;
    en_name: string;
    zh_name: string;
    is_current: string;
    parent_code?: string;
  };
  level_label?: string;
  hierarchies?: Array<Record<string, string>>;
  smq_memberships?: Array<Record<string, string>>;
  children_count?: number;
  relationships?: RelationshipData;
}

interface SmqDetail {
  found: boolean;
  smq?: TreeNode & Record<string, string>;
  children?: TreeNode[];
  parents?: TreeNode[];
  content?: Array<Record<string, string>>;
  relationships?: RelationshipData;
}

interface RelationNode {
  level: string;
  level_label?: string;
  code: string;
  display_name?: string;
  en_name?: string;
  zh_name?: string;
  children_count?: number;
  is_current?: string;
}

interface RelationshipData {
  parents?: RelationNode[];
  children?: RelationNode[];
  hierarchy_paths?: Array<Record<string, string>>;
  primary_paths?: Array<Record<string, string>>;
  smq_memberships?: Array<Record<string, string>>;
  content?: Array<Record<string, string>>;
  content_count?: number;
}

interface RelationshipTreeNode {
  level: string;
  levelLabel?: string;
  code: string;
  name: string;
  meta?: string;
  current?: boolean;
  inactive?: boolean;
}

interface Status {
  version: string;
  available_languages: string[];
  search_levels: SearchLevel[];
  available_versions: ReleaseInfo[];
  counts: Array<{ lang: string; file_name: string; row_count: number }>;
  term_counts: Array<{ level: string; n: number }>;
  smq_count: number;
  db_path: string;
  source_directories: Record<string, string>;
}

interface ReleaseInfo {
  version: string;
  complete: boolean;
  usable?: boolean;
  available_languages?: string[];
  missing_languages: string[];
  english_dir: string;
  chinese_dir: string;
}

interface SourceRoot {
  path: string;
  exists: boolean;
  release_count: number;
  releases: ReleaseInfo[];
}

interface SynonymRow {
  lang: string;
  phrase: string;
  synonym_group: string;
  weight?: number;
}

interface PaneWidths {
  left: number;
  right: number;
}

const API = "/api";
const DEFAULT_PANES: PaneWidths = { left: 320, right: 340 };
const MIN_LEFT_PANE_WIDTH = 240;
const MAX_LEFT_PANE_WIDTH = 520;
const MIN_RIGHT_PANE_WIDTH = 280;
const MAX_RIGHT_PANE_WIDTH = 560;
const STACKED_WORKSPACE_WIDTH = 1100;
const RESIZER_WIDTH_TOTAL = 12;
const LEVEL_OPTIONS: Array<{ key: SearchLevel; label: string; hint: string }> = [
  { key: "PT", label: "PT", hint: "默认" },
  { key: "LLT", label: "LLT", hint: "含非当前" },
  { key: "HLT", label: "HLT", hint: "上位" },
  { key: "HLGT", label: "HLGT", hint: "上位" },
  { key: "SOC", label: "SOC", hint: "顶层" },
  { key: "SMQ", label: "SMQ", hint: "广义/狭义" }
];
const MODULES: Array<{ key: ModuleKey; label: string; icon: JSX.Element }> = [
  { key: "search", label: "搜索", icon: <Search size={16} /> },
  { key: "advanced", label: "高级搜索", icon: <SlidersHorizontal size={16} /> },
  { key: "detail", label: "详情关系", icon: <Layers size={16} /> },
  { key: "bin", label: "Research Bin", icon: <Clipboard size={16} /> },
  { key: "history", label: "历史记录", icon: <History size={16} /> },
  { key: "settings", label: "设置", icon: <Settings size={16} /> }
];

function displayName(item: { en_name?: string; zh_name?: string }, mode: Mode) {
  if (mode === "en") return item.en_name || item.zh_name || "";
  if (mode === "zh") return item.zh_name || item.en_name || "";
  if (item.en_name && item.zh_name && item.en_name !== item.zh_name) {
    return `${item.zh_name} / ${item.en_name}`;
  }
  return item.zh_name || item.en_name || "";
}

function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function rowsToCsv(rows: object[]) {
  if (!rows.length) return "";
  const normalizedRows = rows.map((row) => row as Record<string, unknown>);
  const columns = Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row))));
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.join(","), ...normalizedRows.map((row) => columns.map((col) => escape(row[col])).join(","))].join("\n");
}

function apiPath(path: string, version?: string) {
  if (!version) return `${API}${path}`;
  const separator = path.includes("?") ? "&" : "?";
  return `${API}${path}${separator}version=${encodeURIComponent(version)}`;
}

function isCodeQuery(text: string) {
  return /^\d{2,}$/.test(text.trim());
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function desiredCenterWidth(workspaceWidth: number) {
  if (workspaceWidth <= STACKED_WORKSPACE_WIDTH) return 420;
  if (workspaceWidth >= 1700) return 900;
  if (workspaceWidth >= 1300) return Math.round(workspaceWidth * 0.52);
  return Math.round(workspaceWidth * 0.5);
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

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<Mode>("both");
  const [module, setModule] = useState<ModuleKey>("search");
  const [treeTab, setTreeTab] = useState<"soc" | "smq">("soc");
  const [socRoots, setSocRoots] = useState<TreeNode[]>([]);
  const [smqRoots, setSmqRoots] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, TreeNode[]>>({});
  const [query, setQuery] = useState("横纹肌");
  const [socFilter, setSocFilter] = useState("");
  const [selectedLevels, setSelectedLevels] = useState<SearchLevel[]>(["PT"]);
  const [searchGroups, setSearchGroups] = useState<SearchGroup[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [smqDetail, setSmqDetail] = useState<SmqDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [includeSynonyms, setIncludeSynonyms] = useState(true);
  const [ignoreDiacritics, setIgnoreDiacritics] = useState(true);
  const [includeNonCurrent, setIncludeNonCurrent] = useState(true);
  const [advA, setAdvA] = useState("renal");
  const [advB, setAdvB] = useState("failure");
  const [advOpA, setAdvOpA] = useState("contains");
  const [advOpB, setAdvOpB] = useState("contains");
  const [advBool, setAdvBool] = useState("AND");
  const [advancedResults, setAdvancedResults] = useState<SearchResult[]>([]);
  const [synonyms, setSynonyms] = useState<SynonymRow[]>([]);
  const [sourceRoots, setSourceRoots] = useState<SourceRoot[]>([]);
  const [sourcePath, setSourcePath] = useState("");
  const [importingSource, setImportingSource] = useState(false);
  const [bin, setBin] = useState<SearchResult[]>(() => readStorage<SearchResult[]>("meddra.bin", []));
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => readStorage<PaneWidths>("meddra.panes", DEFAULT_PANES));
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [historyRows, setHistoryRows] = useState<Array<{ action: string; text: string; at: string }>>(() =>
    readStorage<Array<{ action: string; text: string; at: string }>>("meddra.history", [])
  );
  const importRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(apiPath("/status", version))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "后端未找到可用的MedDRA词典目录");
        return data;
      })
      .then((data) => {
        setStatus(data);
        if (!version) setVersion(data.version);
      })
      .catch((error) => {
        setModule("settings");
        setToast((error as Error).message || "后端未启动或索引不可用");
      });
  }, [version]);

  useEffect(() => {
    refreshSourceRoots();
  }, []);

  useEffect(() => {
    if (!version) return;
    fetch(apiPath(`/tree/soc?mode=${mode}`, version))
      .then((res) => res.json())
      .then((data) => setSocRoots(data.nodes || []));
    fetch(apiPath(`/tree/smq?mode=${mode}`, version))
      .then((res) => res.json())
      .then((data) => setSmqRoots(data.nodes || []));
  }, [mode, version]);

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
  }, []);

  const flattenedSearchRows = useMemo(() => searchGroups.flatMap((group) => group.results), [searchGroups]);
  const binKeys = useMemo(() => new Set(bin.map((row) => `${row.level}:${row.code}`)), [bin]);
  const workspaceStyle = {
    "--left-pane-width": `${paneWidths.left}px`,
    "--right-pane-width": `${paneWidths.right}px`,
    "--center-pane-min": `${desiredCenterWidth(workspaceWidth)}px`
  } as CSSProperties;

  async function performSearch(text = query) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const searchText = text.trim();
    setLoading(true);
    setModule("search");
    try {
      if (isCodeQuery(searchText)) {
        const res = await fetch(apiPath(`/code/${encodeURIComponent(searchText)}`, version), { signal: controller.signal });
        const data = await res.json();
        const rows = ((data.matches || []) as Detail[])
          .map((row) => detailToResult(row))
          .filter(Boolean) as SearchResult[];
        setSearchGroups(rows.length ? [{ category: "code", label: "代码匹配", results: rows, count: rows.length }] : []);
        if (data.matches?.[0]) {
          setDetail(data.matches[0]);
          setSmqDetail(null);
        }
        setHistoryCursor(0);
        addHistory("代码搜索", searchText);
        return;
      }
      const res = await fetch(`${API}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: searchText,
          version,
          mode,
          levels: selectedLevels,
          soc_codes: socFilter ? [socFilter] : [],
          include_synonyms: includeSynonyms,
          ignore_diacritics: ignoreDiacritics,
          include_non_current: includeNonCurrent,
          limit_per_group: 80
        }),
        signal: controller.signal
      });
      const data = await res.json();
      setSearchGroups(data.groups || []);
      setHistoryCursor(0);
      addHistory("术语搜索", searchText);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") {
        flash("搜索失败");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  }

  async function performAdvancedSearch() {
    setLoading(true);
    setModule("advanced");
    try {
      const res = await fetch(`${API}/advanced-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          version,
          levels: selectedLevels,
          boolean: advBool,
          conditions: [
            { value: advA, operator: advOpA },
            { value: advB, operator: advOpB }
          ]
        })
      });
      const data = await res.json();
      setAdvancedResults(data.results || []);
      addHistory("高级搜索", `${advA} ${advBool} ${advB}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(level: string, itemCode: string) {
    if (level === "SMQ") {
      await loadSmqDetail(itemCode);
      return;
    }
    const res = await fetch(apiPath(`/details/${level}/${itemCode}`, version));
    if (!res.ok) return;
    const data = await res.json();
    setDetail(data);
    setSmqDetail(null);
    setModule("detail");
    addHistory("打开详情", `${level} ${itemCode}`);
  }

  async function loadSmqDetail(smqCode: string) {
    const res = await fetch(apiPath(`/smq/${smqCode}?mode=${mode}`, version));
    if (!res.ok) return;
    const data = await res.json();
    setSmqDetail(data);
    setDetail(null);
    setModule("detail");
    addHistory("打开SMQ", smqCode);
  }

  async function expandTree(node: TreeNode) {
    const key = `${treeTab}:${node.level}:${node.code || node.smq_code}`;
    if (expanded[key]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    const codeValue = node.code || node.smq_code;
    const url =
      treeTab === "soc"
        ? apiPath(`/tree/soc?level=${node.level}&code=${codeValue}&mode=${mode}`, version)
        : apiPath(`/tree/smq?code=${codeValue}&mode=${mode}`, version);
    const res = await fetch(url);
    const data = await res.json();
    setExpanded((current) => ({ ...current, [key]: data.nodes || [] }));
  }

  async function loadSynonyms(lang: "en" | "zh" = mode === "en" ? "en" : "zh") {
    const res = await fetch(apiPath(`/synonyms?lang=${lang}&limit=120`, version));
    const data = await res.json();
    setSynonyms(data.results || []);
    addHistory("同义词表", lang === "zh" ? "中文" : "英文");
  }

  function addHistory(action: string, text: string) {
    setHistoryRows((rows) => [{ action, text, at: new Date().toLocaleString("zh-CN") }, ...rows].slice(0, 100));
  }

  function addToBin(result: SearchResult) {
    setBin((rows) => {
      if (rows.some((row) => row.level === result.level && row.code === result.code)) {
        flash("已在 Research Bin");
        return rows;
      }
      flash("已加入 Research Bin");
      return [result, ...rows];
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

  function flash(text: string) {
    setToast(text);
    window.setTimeout(() => setToast(""), 1800);
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

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => flash("已复制"));
  }

  async function refreshSourceRoots() {
    const res = await fetch(`${API}/source-roots`);
    if (!res.ok) return;
    const data = await res.json();
    setSourceRoots(data.roots || []);
  }

  async function addDictionarySource() {
    if (!sourcePath.trim()) {
      flash("请先输入词典文件夹路径");
      return;
    }
    setImportingSource(true);
    try {
      const res = await fetch(`${API}/source-roots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourcePath.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        flash(data.detail || "导入目录失败");
        return;
      }
      setSourceRoots(data.roots || []);
      setStatus((current) => current ? { ...current, available_versions: data.releases || current.available_versions } : current);
      setSourcePath("");
      flash("词典来源已加入，可选择版本后重建索引");
    } finally {
      setImportingSource(false);
    }
  }

  async function reindexCurrentVersion() {
    setImportingSource(true);
    try {
      const res = await fetch(apiPath("/reindex", version), { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        flash(data.detail || "重建索引失败");
        return;
      }
      flash(`已重建 MedDRA ${data.version}`);
      const statusRes = await fetch(apiPath("/status", data.version));
      if (statusRes.ok) setStatus(await statusRes.json());
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
    performSearch(rows[next].text);
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/brand/app-icon-256.png" alt="" aria-hidden="true" />
          <div>
            <h1>MedDRA Browser Mac</h1>
            <span>本地词典浏览 · 中文界面 · MedDRA {status?.version || version || "自动选择"}</span>
          </div>
        </div>
        <div className="header-actions">
          <select
            className="version-select"
            value={version}
            title="选择MedDRA版本"
            onChange={(event) => {
              setVersion(event.target.value);
              setExpanded({});
              setSearchGroups([]);
              setDetail(null);
              setSmqDetail(null);
            }}
          >
            {status?.available_versions?.map((release) => (
              <option key={release.version} value={release.version}>
                MedDRA {release.version}（{releaseLanguageLabel(release)}）
              </option>
            ))}
          </select>
          <div className="segmented" aria-label="数据库显示模式">
            {(["zh", "en", "both"] as Mode[]).map((item) => (
              <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>
                <Languages size={14} />
                {item === "zh" ? "中文" : item === "en" ? "英文" : "双语"}
              </button>
            ))}
          </div>
          <button className="icon-button" title="重置搜索" onClick={() => performSearch("横纹肌")}>
            <RotateCcw size={17} />
          </button>
        </div>
      </header>

      <div className="workspace" ref={workspaceRef} style={workspaceStyle}>
        <aside className="left-pane">
          <div className="pane-tabs">
            <button className={treeTab === "soc" ? "active" : ""} onClick={() => setTreeTab("soc")}>
              <ListTree size={16} /> SOC层级
            </button>
            <button className={treeTab === "smq" ? "active" : ""} onClick={() => setTreeTab("smq")}>
              <Layers size={16} /> SMQ层级
            </button>
          </div>
          <div className="tree-scroll">
            {(treeTab === "soc" ? socRoots : smqRoots).map((node) => (
              <TreeRow
                key={`${treeTab}:${node.code || node.smq_code}`}
                node={node}
                depth={0}
                treeTab={treeTab}
                expanded={expanded}
                onExpand={expandTree}
                onOpen={(opened) =>
                  treeTab === "soc"
                    ? loadDetail(opened.level, opened.code || "")
                    : loadSmqDetail(opened.smq_code || opened.code || "")
                }
              />
            ))}
          </div>
        </aside>

        <div
          className="pane-resizer pane-resizer-left"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左侧栏宽度"
          onPointerDown={(event) => startPaneResize("left", event)}
        />

        <main className="center-pane">
          <nav className="module-nav">
            {MODULES.map((item) => (
              <button key={item.key} className={module === item.key ? "active" : ""} onClick={() => setModule(item.key)}>
                {item.icon}
                {item.label}
                {item.key === "bin" && bin.length > 0 && <span className="nav-badge">{bin.length}</span>}
              </button>
            ))}
          </nav>

          {module === "search" && (
            <section className="module">
              <div className="query-bar">
                <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && performSearch()} placeholder="输入术语、中文片段、英文拼写或代码" />
                <button className="primary" onClick={() => performSearch()} disabled={loading}>
                  <Search size={16} /> 搜索
                </button>
                <button onClick={cancelSearch} disabled={!loading}>
                  <Square size={14} /> 取消
                </button>
                <button onClick={exportSearch} disabled={!flattenedSearchRows.length}>
                  <Download size={16} /> 导出
                </button>
                <button onClick={() => setQuery("")}>
                  清除
                </button>
              </div>
              <div className="filter-row">
                <label>
                  SOC过滤
                  <select value={socFilter} onChange={(event) => setSocFilter(event.target.value)}>
                    <option value="">全部SOC</option>
                    {socRoots.map((soc) => (
                      <option key={soc.code} value={soc.code}>{displayName(soc, mode)}</option>
                    ))}
                  </select>
                </label>
                <button onClick={() => navigateSearchHistory(1)}>上一条</button>
                <button onClick={() => navigateSearchHistory(-1)}>下一条</button>
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
              <SearchGroups groups={searchGroups} onOpen={loadDetail} onBin={addToBin} onRemove={removeFromBin} binKeys={binKeys} />
            </section>
          )}

          {module === "advanced" && (
            <section className="module">
              <LevelFilter selectedLevels={selectedLevels} onToggle={toggleLevel} />
              <div className="advanced-grid">
                <select value={advOpA} onChange={(event) => setAdvOpA(event.target.value)}>
                  <option value="contains">包含</option>
                  <option value="begins">开头为</option>
                  <option value="exact">完全等于</option>
                  <option value="ends">结尾为</option>
                </select>
                <input value={advA} onChange={(event) => setAdvA(event.target.value)} />
                <select value={advBool} onChange={(event) => setAdvBool(event.target.value)}>
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                  <option value="NOT">NOT</option>
                </select>
                <select value={advOpB} onChange={(event) => setAdvOpB(event.target.value)}>
                  <option value="contains">包含</option>
                  <option value="begins">开头为</option>
                  <option value="exact">完全等于</option>
                  <option value="ends">结尾为</option>
                </select>
                <input value={advB} onChange={(event) => setAdvB(event.target.value)} />
                <button className="primary" onClick={performAdvancedSearch}>
                  <Search size={16} /> 高级搜索
                </button>
              </div>
              <ResultList results={advancedResults} onOpen={loadDetail} onBin={addToBin} onRemove={removeFromBin} binKeys={binKeys} />
            </section>
          )}

          {module === "detail" && (
            <section className="module">
              <DetailWorkspace
                detail={detail}
                smqDetail={smqDetail}
                mode={mode}
                onCopy={copy}
                onExportSmq={exportSmq}
                onOpen={loadDetail}
                onOpenSmq={loadSmqDetail}
              />
            </section>
          )}

          {module === "bin" && (
            <section className="module">
              <div className="query-bar">
                <button onClick={exportBin} disabled={!bin.length}>
                  <Download size={16} /> 导出JSON
                </button>
                <button onClick={() => downloadText("meddra_research_bin.csv", rowsToCsv(bin), "text/csv;charset=utf-8")} disabled={!bin.length}>
                  <Download size={16} /> 导出CSV
                </button>
                <button onClick={() => importRef.current?.click()}>
                  <Upload size={16} /> 导入 Bin
                </button>
                <button onClick={() => setBin([])} disabled={!bin.length}>
                  <Trash2 size={16} /> 清空
                </button>
                <input ref={importRef} type="file" accept=".json,.csv,text/csv" hidden onChange={importBin} />
              </div>
              <ResultList results={bin} onOpen={loadDetail} onBin={addToBin} onRemove={removeFromBin} binKeys={binKeys} binMode />
            </section>
          )}

          {module === "history" && (
            <section className="module">
              <div className="history-list">
                {historyRows.map((row, index) => (
                  <button key={`${row.at}-${index}`} onClick={() => row.action.includes("搜索") && performSearch(row.text)}>
                    <span>{row.action}</span>
                    <strong>{row.text}</strong>
                    <time>{row.at}</time>
                  </button>
                ))}
              </div>
            </section>
          )}

          {module === "settings" && (
            <section className="module settings-panel">
              <OptionsRow
                includeSynonyms={includeSynonyms}
                setIncludeSynonyms={setIncludeSynonyms}
                ignoreDiacritics={ignoreDiacritics}
                setIgnoreDiacritics={setIgnoreDiacritics}
                includeNonCurrent={includeNonCurrent}
                setIncludeNonCurrent={setIncludeNonCurrent}
              />
              <div className="status-grid">
                <Metric label="SMQ数量" value={status?.smq_count ?? 0} />
                {status?.term_counts.map((row) => <Metric key={row.level} label={row.level} value={row.n} />)}
              </div>
              <div className="source-import">
                <header>
                  <h2>词典来源导入</h2>
                  <p>输入包含 MedDRA ASCII 文件的文件夹路径；可填具体 MedAscii/ascii 目录，也可填其上级版本目录或工作目录。</p>
                </header>
                <div className="required-files">
                  {["soc.asc", "pt.asc", "llt.asc", "mdhier.asc", "smq_list.asc", "smq_content.asc"].map((file) => (
                    <code key={file}>{file}</code>
                  ))}
                </div>
                <div className="query-bar compact">
                  <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/path/to/MedAscii 或 /path/to/ascii_290" />
                  <button className="primary" onClick={addDictionarySource} disabled={importingSource}>
                    <Upload size={16} /> 加入来源
                  </button>
                  <button onClick={reindexCurrentVersion} disabled={importingSource || !version}>
                    <RotateCcw size={16} /> 重建当前版本
                  </button>
                </div>
              </div>
              <div className="query-bar compact">
                <button onClick={() => loadSynonyms("zh")}>查看中文同义词表</button>
                <button onClick={() => loadSynonyms("en")}>查看英文同义词表</button>
              </div>
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
              <div className="release-list">
                {status?.available_versions?.map((release) => (
                  <div key={release.version}>
                    <strong>MedDRA {release.version}</strong>
                    <span>{releaseLanguageLabel(release)}</span>
                  </div>
                ))}
              </div>
              <div className="source-root-list">
                {sourceRoots.map((root) => (
                  <div key={root.path}>
                    <strong>{root.path}</strong>
                    <span>{root.exists ? `${root.release_count} 个版本` : "路径不可用"}</span>
                  </div>
                ))}
              </div>
              <code className="db-path">EN: {status?.source_directories?.en}</code>
              <code className="db-path">ZH: {status?.source_directories?.zh}</code>
              <code className="db-path">{status?.db_path}</code>
            </section>
          )}
        </main>

        <div
          className="pane-resizer pane-resizer-right"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧关系树宽度"
          onPointerDown={(event) => startPaneResize("right", event)}
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  treeTab,
  expanded,
  onExpand,
  onOpen
}: {
  node: TreeNode;
  depth: number;
  treeTab: "soc" | "smq";
  expanded: Record<string, TreeNode[]>;
  onExpand: (node: TreeNode) => void;
  onOpen: (node: TreeNode) => void;
}) {
  const key = `${treeTab}:${node.level}:${node.code || node.smq_code}`;
  const children = expanded[key];
  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
        <button className="tree-toggle" onClick={() => node.has_children !== false && onExpand(node)} title="展开">
          <ChevronRight size={14} className={children ? "rotated" : ""} />
        </button>
        <button className="tree-label" onClick={() => onOpen(node)} title={`${node.display_name} · ${node.code || node.smq_code}`}>
          <span className={`level-badge level-${node.level}`}>{node.level}</span>
          <strong>{node.display_name}</strong>
          <em>{node.code || node.smq_code}</em>
        </button>
      </div>
      {children?.map((child) => (
        <TreeRow key={`${key}:${child.code || child.smq_code}`} node={child} depth={depth + 1} treeTab={treeTab} expanded={expanded} onExpand={onExpand} onOpen={onOpen} />
      ))}
    </div>
  );
}

function LevelFilter({
  selectedLevels,
  onToggle
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
            <button key={item.key} className={active ? `active level-${item.key}` : ""} onClick={() => onToggle(item.key)}>
              {active && <Check size={13} />}
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
      <label><input type="checkbox" checked={props.includeSynonyms} onChange={(event) => props.setIncludeSynonyms(event.target.checked)} /> 使用同义词表</label>
      <label><input type="checkbox" checked={props.ignoreDiacritics} onChange={(event) => props.setIgnoreDiacritics(event.target.checked)} /> 忽略变音符号</label>
      <label><input type="checkbox" checked={props.includeNonCurrent} onChange={(event) => props.setIncludeNonCurrent(event.target.checked)} /> 显示非当前LLT/非活动SMQ条目</label>
    </div>
  );
}

function SearchGroups({
  groups,
  onOpen,
  onBin,
  onRemove,
  binKeys
}: {
  groups: SearchGroup[];
  onOpen: (level: string, code: string) => void;
  onBin: (result: SearchResult) => void;
  onRemove: (result: SearchResult) => void;
  binKeys: Set<string>;
}) {
  if (!groups.length) return <EmptyState text="输入术语、中文/英文片段或 MedDRA 代码后按 Enter 或点击搜索。" />;
  return (
    <div className="group-stack">
      {groups.map((group) => (
        <section className="result-group" key={group.category}>
          <header>
            <h2>{group.label}</h2>
            <span>{group.count}</span>
          </header>
          <ResultList results={group.results} onOpen={onOpen} onBin={onBin} onRemove={onRemove} binKeys={binKeys} />
        </section>
      ))}
    </div>
  );
}

function ResultList({
  results,
  onOpen,
  onBin,
  onRemove,
  binKeys,
  binMode = false
}: {
  results: SearchResult[];
  onOpen: (level: string, code: string) => void;
  onBin: (result: SearchResult) => void;
  onRemove?: (result: SearchResult) => void;
  binKeys: Set<string>;
  binMode?: boolean;
}) {
  if (!results.length) return <EmptyState text="暂无结果" />;
  return (
    <div className="result-list">
      {results.map((result, index) => {
        const inBin = binKeys.has(`${result.level}:${result.code}`);
        return (
          <article className={result.category === "fuzzy" ? "result fuzzy" : "result"} key={`${result.level}:${result.code}:${index}`}>
            <button className="result-main" onClick={() => onOpen(result.level, result.code)}>
              <span className={`level-badge level-${result.level}`}>{result.level}</span>
              <strong>{result.zh_name || result.en_name}</strong>
              {result.en_name && result.zh_name && <small>{result.en_name}</small>}
              <em>{result.code}</em>
            </button>
            <div className="result-meta">
              <span>{result.category_label}</span>
              <span>{result.matched_field}</span>
              <p>{result.reason}</p>
            </div>
            <div className="result-actions">
              {binMode ? (
                <button className="danger-action" title="从Research Bin移除" onClick={() => onRemove?.(result)}><Trash2 size={15} />移除</button>
              ) : inBin ? (
                <>
                  <button className="bin-state" title="已加入Research Bin" disabled><Check size={15} />已加入</button>
                  {onRemove && <button title="从Research Bin移除" onClick={() => onRemove(result)}><Trash2 size={15} /></button>}
                </>
              ) : (
                <button title="加入Research Bin" onClick={() => onBin(result)}><Clipboard size={15} />加入</button>
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
  onCopy,
  onExportSmq,
  onOpen,
  onOpenSmq
}: {
  detail: Detail | null;
  smqDetail: SmqDetail | null;
  mode: Mode;
  onCopy: (text: string) => void;
  onExportSmq: () => void;
  onOpen: (level: string, code: string) => void;
  onOpenSmq: (code: string) => void;
}) {
  if (smqDetail?.smq) {
    const smq = smqDetail.smq;
    const content = smqDetail.relationships?.content || smqDetail.content || [];
    return (
      <div className="detail-workspace">
        <header className="detail-hero">
          <span className="level-badge level-SMQ">SMQ</span>
          <div>
            <h2>{displayName(smq, mode)}</h2>
            <p>{smq.smq_code}</p>
          </div>
          <div className="detail-actions">
            <button onClick={() => onCopy(smq.smq_code || "")}><Clipboard size={15} /> 复制代码</button>
            <button onClick={onExportSmq}><Download size={15} /> 导出SMQ</button>
          </div>
        </header>

        <section className="relationship-section">
          <h3>SMQ说明</h3>
          <p>{mode === "en" ? smq.en_description : smq.zh_description || smq.en_description || "无说明"}</p>
        </section>

        <section className="relationship-section">
          <h3>包含术语 <span>{content.length}</span></h3>
          <div className="wide-table">
            {content.slice(0, 240).map((row) => (
              <button key={`${row.term_code}-${row.scope}-${row.term_level}`} onClick={() => onOpen(String(row.term_level || "PT"), String(row.term_code))}>
                <span className={`level-badge level-${row.term_level}`}>{row.term_level}</span>
                <strong>{mode === "en" ? row.en_name : row.zh_name || row.en_name}</strong>
                <em>{row.term_code}</em>
                <small>{row.scope_label} · {row.status_label}</small>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  if (!detail?.term) {
    return <EmptyState text="从搜索结果、SOC层级或SMQ层级打开一个条目后，这里会显示完整上下游关系。" />;
  }

  const term = detail.term;
  const relationships = detail.relationships || {};
  const paths = relationships.hierarchy_paths || detail.hierarchies || [];
  const memberships = relationships.smq_memberships || detail.smq_memberships || [];
  const currentText = term.level === "LLT" ? (term.is_current === "Y" ? "当前LLT" : "非当前LLT") : "当前术语";

  return (
    <div className="detail-workspace">
      <header className="detail-hero">
        <span className={`level-badge level-${term.level}`}>{term.level}</span>
        <div>
          <h2>{displayName(term, mode)}</h2>
          <p>{term.code} · {currentText}</p>
        </div>
        <div className="detail-actions">
          <button onClick={() => onCopy(term.code)}><Clipboard size={15} /> 复制代码</button>
          <button onClick={() => onCopy(displayName(term, mode))}><Clipboard size={15} /> 复制术语</button>
        </div>
      </header>

      <section className="relationship-section">
        <h3>父系层级路径 <span>{dedupeHierarchyPaths(paths, term.level).length}</span></h3>
        <div className="path-lanes">
          {dedupeHierarchyPaths(paths, term.level).map((row, index) => (
            <div key={`${row.path_key}-${index}`}>
              <b>{row.primary_soc === "Y" ? "主SOC" : "次SOC"}</b>
              {hierarchySegments(row, term.level, mode, displayName(term, mode)).map((segment, segmentIndex) => (
                <span className={segment.level === term.level ? "current-path-node" : ""} key={`${segment.level}:${segment.code || segment.name}`}>
                  {segmentIndex > 0 && <ChevronRight size={14} />}
                  <strong>{segment.level}</strong>
                  {segment.name}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="relationship-section">
        <h3>SMQ成员关系 <span>{memberships.length}</span></h3>
        <div className="wide-table">
          {memberships.slice(0, 160).map((row) => (
            <button key={`${row.smq_code}-${row.term_code}-${row.scope}`} onClick={() => onOpenSmq(String(row.smq_code))}>
              <span className="level-badge level-SMQ">SMQ</span>
              <strong>{mode === "en" ? row.smq_en_name : row.smq_zh_name || row.smq_en_name}</strong>
              <em>{row.smq_code}</em>
              <small>{row.scope_label} · {row.status_label}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function RelationshipTreePanel({
  detail,
  smqDetail,
  mode,
  onOpen,
  onOpenSmq
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
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOpenGroups({});
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
          {parents.length ? parents.map((parent, index) => (
            <div className="relation-tree-branch" key={`smq-parent:${parent.smq_code || parent.code}:${index}`}>
              <div className="relation-tree-path-label">SMQ父级路径 {index + 1}</div>
              <RelationshipTreeNodeRow node={smqTreeNode(parent, mode)} depth={0} onClick={() => onOpenSmq(parent.smq_code || parent.code || "")} />
              <RelationshipTreeNodeRow node={currentNode} depth={1} onClick={() => onOpenSmq(smq.smq_code || smq.code || "")} />
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
          )) : (
            <div className="relation-tree-branch">
              <div className="relation-tree-path-label">SMQ当前节点</div>
              <RelationshipTreeNodeRow node={currentNode} depth={0} onClick={() => onOpenSmq(smq.smq_code || smq.code || "")} />
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
        <p>{term.level} · {term.code}</p>
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
                {row.primary_soc === "Y" ? "主SOC路径" : row.primary_soc === "N" ? "次SOC路径" : "当前节点"} {paths.length > 1 ? index + 1 : ""}
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
                      meta: isCurrent ? currentTermMeta(term) : undefined
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
  onClick
}: {
  node: RelationshipTreeNode;
  depth: number;
  onClick?: () => void;
}) {
  const className = [
    "relationship-tree-node",
    node.current ? "current" : "",
    node.inactive ? "inactive" : ""
  ].filter(Boolean).join(" ");
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
    <button className={className} style={depthStyle(depth)} onClick={onClick}>
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
  onOpenNode
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
      <button className="relationship-tree-toggle" style={depthStyle(depth)} onClick={() => onToggle(groupKey)}>
        <ChevronRight size={14} className={open ? "rotated" : ""} />
        <span>{title}</span>
        <strong>{nodes.length}</strong>
      </button>
      {open && (
        <div className="relationship-tree-children">
          {nodes.length ? nodes.map((node, index) => (
            <RelationshipTreeNodeRow
              key={`${groupKey}:${node.level}:${node.code}:${index}`}
              node={node}
              depth={depth + 1}
              onClick={() => onOpenNode(node)}
            />
          )) : (
            <div className="relationship-tree-empty" style={depthStyle(depth + 1)}>无直接子级</div>
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
    meta: node.children_count ? `${node.children_count.toLocaleString("zh-CN")} 个子级` : undefined
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
    meta: node.smq_level ? `层级 ${node.smq_level}` : undefined
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
    meta: [row.scope_label, row.status_label].filter(Boolean).join(" · ")
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
    PT: ["soc_code", "hlgt_code", "hlt_code", "pt_code"]
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

function hierarchySegments(row: Record<string, string>, selectedLevel: string, mode: Mode, selectedName: string, selectedCode = "") {
  const levels: Array<"SOC" | "HLGT" | "HLT" | "PT"> = ["SOC", "HLGT", "HLT", "PT"];
  const stopAt = selectedLevel === "LLT" ? "PT" : selectedLevel;
  const stopIndex = Math.max(0, levels.indexOf(stopAt as "SOC" | "HLGT" | "HLT" | "PT"));
  const base: Array<{ level: string; code: string; name: string }> = levels.slice(0, stopIndex + 1).map((level) => ({
    level,
    code: row[`${level.toLowerCase()}_code`],
    name: hierarchyName(row, level.toLowerCase() as "soc" | "hlgt" | "hlt" | "pt", mode)
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
    reason: "代码匹配结果"
  };
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
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
    reason: String(row.reason || "Research Bin导入")
  };
}
