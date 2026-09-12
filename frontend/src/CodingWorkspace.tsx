import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, FileSpreadsheet, Loader2, RotateCcw, Search, Upload, X } from "lucide-react";

type CodingType = string;
type DecisionStatus = "pending" | "accepted" | "edited" | "rejected";

interface CodingOccurrence {
  sheet?: string;
  column?: string;
  excel_row?: number | string;
  [meta: string]: unknown;
}

interface SuggestionItem {
  level: string;
  level_label?: string;
  code: string;
  en_name?: string;
  zh_name?: string;
  is_current?: string;
  match_type?: string;
  score?: number;
  reason?: string;
  parent_code?: string;
}

interface UniqueTerm {
  term: string;
  coding_type: CodingType;
  count: number;
  occurrences: CodingOccurrence[];
  suggestion?: {
    best?: SuggestionItem | null;
    pt?: SuggestionItem | null;
    candidates?: SuggestionItem[];
    status?: string;
  };
}

interface Decision {
  status: DecisionStatus;
  pt_code?: string;
  pt_zh?: string;
  pt_en?: string;
  llt_code?: string;
  llt_zh?: string;
  llt_en?: string;
  note?: string;
}

interface ImportStats {
  sheet_count: number;
  data_rows: number;
  target_count: number;
  unique_term_count: number;
}

interface ImportResult {
  filename: string;
  stats: ImportStats;
  coding_targets: Array<{ sheet: string; column: string; coding_type: string; non_empty_count: number }>;
  unique_terms: UniqueTerm[];
}

interface CodingWorkspaceProps {
  version: string;
  mode: "zh" | "en" | "both";
  versionReady: boolean;
  apiBase: string;
  onOpenDetail?: (item: { level: string; code: string }) => void;
  flash?: (message: string) => void;
}

const STORAGE_KEY = "meddra.coding.session.v1";

const STATUS_LABEL: Record<DecisionStatus, string> = {
  pending: "待审",
  accepted: "已接受",
  edited: "已改码",
  rejected: "已拒绝",
};

function decisionKey(term: UniqueTerm) {
  return `${term.coding_type}|${term.term}`;
}

function displayNameOf(item: SuggestionItem | null | undefined, mode: CodingWorkspaceProps["mode"]) {
  if (!item) return "";
  if (mode === "en") return item.en_name || item.zh_name || "";
  if (mode === "zh") return item.zh_name || item.en_name || "";
  if (item.zh_name && item.en_name && item.zh_name !== item.en_name) {
    return `${item.zh_name} / ${item.en_name}`;
  }
  return item.zh_name || item.en_name || "";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = `请求失败 (${response.status})`;
    try {
      const payload = await response.json();
      if (typeof payload?.detail === "string") detail = payload.detail;
      else if (payload?.detail) detail = JSON.stringify(payload.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

function readSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as {
      filename?: string;
      stats?: ImportStats;
      coding_targets?: ImportResult["coding_targets"];
      unique_terms?: UniqueTerm[];
      decisions?: Record<string, Decision>;
    };
  } catch {
    return null;
  }
}

function writeSession(payload: {
  filename: string;
  stats: ImportStats | null;
  coding_targets: ImportResult["coding_targets"];
  unique_terms: UniqueTerm[];
  decisions: Record<string, Decision>;
}) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode: session stays in memory only */
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function emptyDecisionFromBest(best?: SuggestionItem | null, pt?: SuggestionItem | null): Decision {
  if (!best) return { status: "pending" };
  if (best.level === "PT") {
    return {
      status: "accepted",
      pt_code: best.code,
      pt_zh: best.zh_name || "",
      pt_en: best.en_name || "",
    };
  }
  return {
    status: "accepted",
    llt_code: best.code,
    llt_zh: best.zh_name || "",
    llt_en: best.en_name || "",
    pt_code: pt?.code || best.parent_code || "",
    pt_zh: pt?.zh_name || "",
    pt_en: pt?.en_name || "",
  };
}

export default function CodingWorkspace({
  version,
  mode,
  versionReady,
  apiBase,
  onOpenDetail,
  flash,
}: CodingWorkspaceProps) {
  const [stats, setStats] = useState<ImportStats | null>(null);
  const [filename, setFilename] = useState("");
  const [targets, setTargets] = useState<ImportResult["coding_targets"]>([]);
  const [terms, setTerms] = useState<UniqueTerm[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [importing, setImporting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filterText, setFilterText] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | DecisionStatus | "no_match">("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [restored, setRestored] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (restored) return;
    const saved = readSession();
    if (saved?.unique_terms?.length) {
      setFilename(saved.filename || "已恢复会话");
      setStats(saved.stats || null);
      setTargets(saved.coding_targets || []);
      setTerms(saved.unique_terms);
      setDecisions(saved.decisions || {});
      setNotice("已从本地恢复上次编码会话");
    }
    setRestored(true);
  }, [restored]);

  useEffect(() => {
    if (!restored || !terms.length) return;
    writeSession({
      filename,
      stats,
      coding_targets: targets,
      unique_terms: terms,
      decisions,
    });
  }, [restored, filename, stats, targets, terms, decisions]);

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    terms.forEach((item) => set.add(item.coding_type));
    return Array.from(set).sort();
  }, [terms]);

  const summary = useMemo(() => {
    let accepted = 0;
    let edited = 0;
    let rejected = 0;
    let pending = 0;
    let noMatch = 0;
    terms.forEach((item) => {
      const decision = decisions[decisionKey(item)];
      const status = decision?.status || "pending";
      if (status === "accepted") accepted += 1;
      else if (status === "edited") edited += 1;
      else if (status === "rejected") rejected += 1;
      else pending += 1;
      if (!item.suggestion?.best) noMatch += 1;
    });
    return { accepted, edited, rejected, pending, noMatch, total: terms.length };
  }, [terms, decisions]);

  const visibleTerms = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return terms.filter((item) => {
      if (filterType !== "all" && item.coding_type !== filterType) return false;
      const decision = decisions[decisionKey(item)];
      const status = decision?.status || "pending";
      if (filterStatus === "no_match") {
        if (item.suggestion?.best) return false;
      } else if (filterStatus !== "all" && status !== filterStatus) {
        return false;
      }
      if (!query) return true;
      const haystack = [
        item.term,
        item.coding_type,
        item.suggestion?.best?.zh_name,
        item.suggestion?.best?.en_name,
        item.suggestion?.best?.code,
        decision?.pt_code,
        decision?.llt_code,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [terms, decisions, filterText, filterStatus, filterType]);

  function persistTerms(nextTerms: UniqueTerm[], nextDecisions: Record<string, Decision>, nextFilename: string, nextStats: ImportStats | null, nextTargets: ImportResult["coding_targets"]) {
    setTerms(nextTerms);
    setDecisions(nextDecisions);
    setFilename(nextFilename);
    setStats(nextStats);
    setTargets(nextTargets);
  }

  async function handleImport(file: File) {
    setError("");
    setNotice("");
    setImporting(true);
    try {
      const content = await fileToBase64(file);
      const parsed = await fetchJson<ImportResult>(`${apiBase}/coding/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content_base64: content }),
      });
      const nextDecisions: Record<string, Decision> = {};
      // Auto-accept high-confidence exact matches; leave the rest for review.
      parsed.unique_terms.forEach((item) => {
        const best = item.suggestion?.best;
        if (best && best.match_type === "exact" && (best.score ?? 0) >= 99) {
          nextDecisions[decisionKey(item)] = emptyDecisionFromBest(best, item.suggestion?.pt);
        }
      });
      persistTerms(parsed.unique_terms, nextDecisions, parsed.filename, parsed.stats, parsed.coding_targets);
      setNotice(
        `已导入 ${parsed.stats.data_rows} 行，识别 ${parsed.stats.target_count} 个待编码列，共 ${parsed.stats.unique_term_count} 个唯一术语`
      );
      if (parsed.stats.unique_term_count > 0) {
        await runSuggest(parsed.unique_terms, version, mode);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function runSuggest(sourceTerms: UniqueTerm[] = terms, ver: string = version, m: CodingWorkspaceProps["mode"] = mode) {
    if (!sourceTerms.length) return;
    setError("");
    setSuggesting(true);
    try {
      const payloadTerms = sourceTerms.map((item) => item.term);
      const data = await fetchJson<{ suggestions: Record<string, UniqueTerm["suggestion"]> }>(
        `${apiBase}/coding/suggest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ terms: payloadTerms, version: ver || null, mode: m, limit_per_term: 5 }),
        }
      );
      const merged = sourceTerms.map((item) => ({
        ...item,
        suggestion: data.suggestions[item.term] || item.suggestion,
      }));
      const nextDecisions = { ...decisions };
      merged.forEach((item) => {
        const key = decisionKey(item);
        if (nextDecisions[key]?.status && nextDecisions[key]?.status !== "pending") return;
        const best = item.suggestion?.best;
        if (best && best.match_type === "exact" && (best.score ?? 0) >= 99) {
          nextDecisions[key] = emptyDecisionFromBest(best, item.suggestion?.pt);
        }
      });
      setTerms(merged);
      setDecisions(nextDecisions);
      const matched = merged.filter((item) => item.suggestion?.best).length;
      setNotice(`已完成 ${merged.length} 个术语的自动建议（命中 ${matched} 个）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "自动建议失败");
    } finally {
      setSuggesting(false);
    }
  }

  async function runPasteDryRun() {
    const lines = pasteText
      .split(/[\n,，;；\t]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      setError("请先粘贴术语列表（每行一个，或用逗号分隔）");
      return;
    }
    const counts = new Map<string, number>();
    lines.forEach((term) => counts.set(term, (counts.get(term) || 0) + 1));
    const nextTerms: UniqueTerm[] = Array.from(counts.entries()).map(([term, count]) => ({
      term,
      coding_type: "AE",
      count,
      occurrences: [{ sheet: "粘贴列表", column: "verbatim" }],
    }));
    setError("");
    setDecisions({});
    persistTerms(nextTerms, {}, `粘贴列表-${nextTerms.length}词`, {
      sheet_count: 1,
      data_rows: lines.length,
      target_count: 1,
      unique_term_count: nextTerms.length,
    }, [{ sheet: "粘贴列表", column: "verbatim", coding_type: "AE", non_empty_count: lines.length }]);
    setNotice(`已载入 ${nextTerms.length} 个唯一术语，开始自动建议`);
    await runSuggest(nextTerms);
  }

  function applyDecision(item: UniqueTerm, decision: Decision) {
    setDecisions((prev) => ({ ...prev, [decisionKey(item)]: decision }));
  }

  function acceptBest(item: UniqueTerm) {
    const best = item.suggestion?.best;
    if (!best) {
      flash?.("该术语暂无自动建议，请手动改码");
      return;
    }
    applyDecision(item, emptyDecisionFromBest(best, item.suggestion?.pt));
  }

  function acceptCandidate(item: UniqueTerm, candidate: SuggestionItem) {
    applyDecision(item, emptyDecisionFromBest(candidate, item.suggestion?.pt));
  }

  function rejectTerm(item: UniqueTerm) {
    applyDecision(item, {
      ...decisions[decisionKey(item)],
      status: "rejected",
    });
  }

  function resetTerm(item: UniqueTerm) {
    applyDecision(item, { status: "pending" });
  }

  function acceptAllExact() {
    const next = { ...decisions };
    let count = 0;
    terms.forEach((item) => {
      const key = decisionKey(item);
      const status = next[key]?.status;
      if (status === "accepted" || status === "edited" || status === "rejected") return;
      const best = item.suggestion?.best;
      if (best && best.match_type === "exact" && (best.score ?? 0) >= 99) {
        next[key] = emptyDecisionFromBest(best, item.suggestion?.pt);
        count += 1;
      }
    });
    setDecisions(next);
    flash?.(`已批量接受 ${count} 个完全匹配术语`);
  }

  async function handleExport() {
    setError("");
    setExporting(true);
    try {
      const response = await fetch(`${apiBase}/coding/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unique_terms: terms,
          decisions,
          filename: `meddra_coded_${(filename || "listing").replace(/\.[^.]+$/, "")}.csv`,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload?.detail === "string" ? payload.detail : "导出失败");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/i);
      const name = match?.[1] || "meddra_coded_listing.csv";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("编码结果已导出");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  function clearSession() {
    setTerms([]);
    setDecisions({});
    setStats(null);
    setTargets([]);
    setFilename("");
    setNotice("");
    setError("");
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void handleImport(file);
  }

  const statusFilterOptions: Array<{ value: "all" | DecisionStatus | "no_match"; label: string }> = [
    { value: "all", label: "全部状态" },
    { value: "pending", label: "待审" },
    { value: "accepted", label: "已接受" },
    { value: "edited", label: "已改码" },
    { value: "rejected", label: "已拒绝" },
    { value: "no_match", label: "无建议" },
  ];

  return (
    <section className="module coding-module">
      <div className="coding-hero">
        <div>
          <h2>批量编码 / Data Listing 审阅</h2>
          <p className="coding-subtitle">
            导入 EDC Data Listing（xlsx / csv），系统按唯一原文术语给出 PT/LLT 建议，编码员逐条审阅后导出编码清单。
          </p>
        </div>
        <div className="coding-hero-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xlsm,.csv"
            onChange={onFileChange}
            hidden
            aria-label="选择 Data Listing 文件"
          />
          <button className="kz-btn primary" disabled={importing} onClick={() => fileInputRef.current?.click()}>
            {importing ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
            导入 Listing
          </button>
          <button className="kz-btn" disabled={suggesting || !terms.length || !versionReady} onClick={() => void runSuggest()}>
            {suggesting ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
            重新建议
          </button>
          <button className="kz-btn" disabled={suggesting || !pasteText.trim() || !versionReady} onClick={() => void runPasteDryRun()}>
            {suggesting ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
            粘贴列表干跑
          </button>
          <button className="kz-btn" disabled={!terms.length} onClick={acceptAllExact}>
            <Check size={16} /> 批量接受精确匹配
          </button>
          <button className="kz-btn primary" disabled={exporting || !terms.length} onClick={() => void handleExport()}>
            {exporting ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
            导出编码清单
          </button>
          <button className="kz-btn ghost" disabled={!terms.length} onClick={clearSession}>
            <RotateCcw size={16} /> 清空会话
          </button>
        </div>
      </div>

      {!versionReady && (
        <div className="coding-banner warn" role="status">
          MedDRA 词典索引尚未就绪，请先在「设置」中选择词典并等待索引完成，再执行自动建议。
        </div>
      )}

      {error && (
        <div className="coding-banner error" role="alert">
          <X size={14} /> {error}
        </div>
      )}
      {notice && !error && (
        <div className="coding-banner info" role="status">
          {notice}
        </div>
      )}

      {stats && (
        <div className="kz-stat-strip" data-component="stat-strip">
          <div className="kz-stat">
            <span className="kz-stat-label">文件</span>
            <span className="kz-stat-value kz-stat-text">{filename}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">数据行</span>
            <span className="kz-stat-value">{stats.data_rows}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">唯一术语</span>
            <span className="kz-stat-value">{stats.unique_term_count}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">已接受</span>
            <span className="kz-stat-value accent">{summary.accepted}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">已改码</span>
            <span className="kz-stat-value">{summary.edited}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">待审</span>
            <span className="kz-stat-value">{summary.pending}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">无建议</span>
            <span className="kz-stat-value risk">{summary.noMatch}</span>
          </div>
        </div>
      )}

      {targets.length > 0 && (
        <div className="coding-targets">
          {targets.map((target) => (
            <span key={`${target.sheet}:${target.column}`} className="coding-chip">
              <FileSpreadsheet size={12} /> {target.sheet} · {target.column} · {target.coding_type} · {target.non_empty_count}
            </span>
          ))}
        </div>
      )}

      {!terms.length && !importing && (
        <div className="kz-empty coding-empty">
          <FileSpreadsheet size={28} />
          <p>尚未导入 Data Listing</p>
          <p className="coding-empty-hint">
            支持 MG-K10 等 EDC 导出的多 Sheet Excel。自动识别待编码列：AETERM（不良事件名称）、MHTERM（疾病名称）、CMINDC（用药原因）、AHDESC（过敏史详述）、ALRTERM、DSDECOD。
          </p>
          <div className="coding-paste-box">
            <label htmlFor="coding-paste">或直接粘贴术语列表（每行一个，用于干跑建议）</label>
            <textarea
              id="coding-paste"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={4}
              placeholder={"头痛\n高血压\n过敏性结膜炎"}
            />
            <button className="kz-btn primary" disabled={suggesting || !pasteText.trim() || !versionReady} onClick={() => void runPasteDryRun()}>
              {suggesting ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
              粘贴列表干跑
            </button>
          </div>
        </div>
      )}

      {terms.length > 0 && (
        <>
          <div className="coding-toolbar">
            <input
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="筛选原文 / PT / 代码"
              aria-label="筛选术语"
            />
            <select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value as typeof filterStatus)} aria-label="按状态筛选">
              {statusFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select value={filterType} onChange={(event) => setFilterType(event.target.value)} aria-label="按类型筛选">
              <option value="all">全部类型</option>
              {typeOptions.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <span className="coding-toolbar-meta">
              显示 {visibleTerms.length} / {terms.length}
            </span>
          </div>

          <div className="coding-table-wrap kz-card" data-density="ultra">
            <table className="coding-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>原文术语</th>
                  <th>次数</th>
                  <th>建议 PT</th>
                  <th>建议 LLT</th>
                  <th>匹配</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleTerms.map((item) => {
                  const key = decisionKey(item);
                  const decision = decisions[key];
                  const status = decision?.status || "pending";
                  const best = item.suggestion?.best;
                  const pt = item.suggestion?.pt || (best?.level === "PT" ? best : null);
                  const llt = best?.level === "LLT" ? best : null;
                  const ptLabel =
                    decision?.pt_zh || decision?.pt_code
                      ? `${decision.pt_code || ""} ${decision.pt_zh || decision.pt_en || ""}`.trim()
                      : displayNameOf(pt, mode) || (pt ? `${pt.code}` : "—");
                  const lltLabel =
                    decision?.llt_zh || decision?.llt_code
                      ? `${decision.llt_code || ""} ${decision.llt_zh || decision.llt_en || ""}`.trim()
                      : displayNameOf(llt, mode) || (llt ? `${llt.code}` : "—");
                  return (
                    <tr key={key} className={`status-${status}`}>
                      <td>
                        <span className={`type-badge type-${item.coding_type}`}>{item.coding_type}</span>
                      </td>
                      <td className="term-cell" title={item.term}>
                        {item.term}
                      </td>
                      <td className="num-cell">{item.count}</td>
                      <td className="code-cell">{ptLabel}</td>
                      <td className="code-cell">{lltLabel}</td>
                      <td>
                        {best ? (
                          <span className={`match-badge match-${best.match_type || "other"}`} title={best.reason}>
                            {best.match_type} · {best.score}
                          </span>
                        ) : (
                          <span className="match-badge match-none">无建议</span>
                        )}
                      </td>
                      <td>
                        <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>
                      </td>
                      <td className="actions-cell">
                        <button className="mini" onClick={() => acceptBest(item)} disabled={!best || status === "accepted"}>
                          接受
                        </button>
                        <button className="mini" onClick={() => rejectTerm(item)} disabled={status === "rejected"}>
                          拒绝
                        </button>
                        <button className="mini" onClick={() => resetTerm(item)} disabled={status === "pending"}>
                          重置
                        </button>
                        {(item.suggestion?.candidates?.length || 0) > 1 && (
                          <details className="candidate-details">
                            <summary className="mini">候选</summary>
                            <ul>
                              {(item.suggestion?.candidates || []).slice(0, 6).map((candidate) => (
                                <li key={`${candidate.level}:${candidate.code}`}>
                                  <button
                                    type="button"
                                    onClick={() => acceptCandidate(item, candidate)}
                                    title={candidate.reason}
                                  >
                                    {candidate.level} {candidate.code} {displayNameOf(candidate, mode)}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {best && onOpenDetail && (
                          <button
                            className="mini"
                            onClick={() => onOpenDetail({ level: best.level, code: best.code })}
                          >
                            详情
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
