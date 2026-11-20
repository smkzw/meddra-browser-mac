import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Edit3,
  FileSpreadsheet,
  Loader2,
  RotateCcw,
  Search,
  Upload,
  X,
} from "lucide-react";
import { CodingRuntimeState, ConfirmDialogState, Detail, Mode, RelationNode, SearchResult } from "./types";

type CodingType = string;
type DecisionStatus = "pending" | "accepted" | "edited" | "rejected";
type DecisionSource = "accept_best" | "batch_exact" | "candidate" | "manual_edit" | "rejected" | "pending";
type StatusFilterValue = "all" | DecisionStatus | "no_match" | "batch_exact";

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
  pt?: SuggestionItem | null;
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
  llt_is_current?: string;
  note?: string;
  meddra_version?: string;
  source_identity?: string;
  source?: DecisionSource;
  updated_at?: string;
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

interface SuggestProgress {
  completedTerms: number;
  totalTerms: number;
  currentBatch: number;
  totalBatches: number;
}

interface VerifiedPair {
  level: "LLT" | "PT";
  code: string;
  en_name: string;
  zh_name: string;
  is_current: string;
  pt_code: string;
  pt_zh: string;
  pt_en: string;
  primary_soc?: string;
  pairedCurrentLlts?: RelationNode[];
}

type ExportKind = "coded" | "exceptions";
type ExportTicket = {
  kind: ExportKind;
  required: ExportKind[];
  session: string;
  revision: number;
};

interface CodingWorkspaceProps {
  version: string;
  sourceIdentity: string;
  mode: Mode;
  versionReady: boolean;
  apiBase: string;
  onOpenDetail?: (item: { level: string; code: string }) => void;
  onRequestSwitchVersion?: (targetVersion: string) => void;
  onSessionStateChange?: (state: CodingRuntimeState) => void;
  onConfirmAction?: (config: ConfirmDialogState) => void;
  flash?: (message: string) => void;
}

const LEGACY_STORAGE_KEYS = ["meddra.coding.session.v1", "meddra.coding.session.v2"];
const SUGGEST_CHUNK_SIZE = 500;
const PAGE_SIZE_OPTIONS = [50, 100, 200];

const STATUS_LABEL: Record<DecisionStatus, string> = {
  pending: "待人工确认",
  accepted: "人工接受",
  edited: "人工改码",
  rejected: "人工拒绝",
};

function newSessionId() {
  return `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function decisionKey(term: UniqueTerm) {
  return `${term.coding_type}|${term.term}`;
}

function displayNameOf(
  item: { en_name?: string; zh_name?: string } | null | undefined,
  mode: Mode
) {
  if (!item) return "";
  if (mode === "en") return item.en_name || item.zh_name || "";
  if (mode === "zh") return item.zh_name || item.en_name || "";
  if (item.zh_name && item.en_name && item.zh_name !== item.en_name) {
    return `${item.zh_name} / ${item.en_name}`;
  }
  return item.zh_name || item.en_name || "";
}

function hasCaseDifference(verbatim: string, item?: { en_name?: string } | null): boolean {
  const v = (verbatim || "").trim();
  const en = (item?.en_name || "").trim();
  if (!v || !en) return false;
  return v.toLowerCase() === en.toLowerCase() && v !== en;
}

function hasExactLiteralMatch(verbatim: string, item?: { zh_name?: string; en_name?: string } | null): boolean {
  if (!item) return false;
  const v = (verbatim || "").trim();
  if (!v) return false;
  return v === (item.zh_name || "").trim() || v === (item.en_name || "").trim();
}

/**
 * Batch exact accept is strictly gated to:
 * 1) Current LLT (level === "LLT" && is_current === "Y")
 * 2) Exact case-sensitive literal match
 * 3) Unique exact current LLT targeting a single verified parent PT
 */
function isStrictBatchExactEligible(item: UniqueTerm): boolean {
  const best = item.suggestion?.best;
  if (!best || best.level !== "LLT" || best.is_current !== "Y") return false;
  if (best.match_type !== "exact" || (best.score ?? 0) < 99) return false;
  if (!hasExactLiteralMatch(item.term, best)) return false;
  const ptCode = item.suggestion?.pt?.code || best.pt?.code || best.parent_code;
  if (!ptCode) return false;
  const candidates = item.suggestion?.candidates || [best];
  const exactLiteralCurrentLlts = candidates.filter(
    (c) => c.level === "LLT" && c.is_current === "Y" && hasExactLiteralMatch(item.term, c)
  );
  const distinctTargetPts = new Set(
    candidates
      .filter((c) => (c.score ?? 0) >= 99 && hasExactLiteralMatch(item.term, c))
      .map((c) => (c.level === "PT" ? c.code : c.pt?.code || c.parent_code || ptCode))
      .filter(Boolean)
  );
  return exactLiteralCurrentLlts.length === 1 && distinctTargetPts.size === 1;
}

function apiPathWithVersion(base: string, path: string, ver?: string) {
  if (!ver) return `${base}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${path}${sep}version=${encodeURIComponent(ver)}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = `请求失败 (${response.status})`;
    try {
      const payload = await response.json();
      if (typeof payload?.detail === "string") detail = payload.detail;
      else if (payload?.detail?.message) detail = String(payload.detail.message);
      else if (payload?.detail) detail = JSON.stringify(payload.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

function isNativeWkWebView(): boolean {
  return typeof window !== "undefined" && Boolean(window.webkit?.messageHandlers?.chooseDictionary);
}

function downloadBlobDeferred(filename: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
  return url;
}

async function resolveCurrentLltsForPt(
  apiBase: string,
  ptCode: string,
  targetVersion: string,
  mode: Mode
): Promise<{
  ptTerm: Detail["term"] | null;
  primarySoc?: string;
  currentLlts: RelationNode[];
  preferred: RelationNode | null;
}> {
  const data = await fetchJson<Detail>(
    apiPathWithVersion(apiBase, `/details/PT/${encodeURIComponent(ptCode)}`, targetVersion)
  );
  if (!data.found || !data.term) {
    return { ptTerm: null, currentLlts: [], preferred: null };
  }
  const paths = data.relationships?.hierarchy_paths || data.hierarchies || [];
  const primary = paths.find((row) => row.primary_soc === "Y") || paths[0];
  const primarySoc = primary
    ? displayNameOf({ en_name: primary.en_soc_name, zh_name: primary.zh_soc_name }, mode)
    : undefined;
  const currentLlts = (data.relationships?.children || []).filter(
    (child) => child.level === "LLT" && child.is_current === "Y"
  );
  const preferred =
    currentLlts.find((child) => child.code === data.term!.code) ||
    currentLlts.find((child) => (child.en_name || "").toLowerCase() === (data.term!.en_name || "").toLowerCase()) ||
    currentLlts[0] ||
    null;
  return { ptTerm: data.term, primarySoc, currentLlts, preferred };
}

async function validateCodingDecisionWithBackend(
  apiBase: string, version: string, sourceSignature: string, decision: Decision
): Promise<Decision> {
  const { results } = await fetchJson<{ results: Record<string, {
    ok: boolean; reason?: string; codes?: Partial<Decision>;
  }> }>(`${apiBase}/coding/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version, source_signature: sourceSignature, decisions: { current: decision } }),
  });
  const checked = results?.current;
  if (!checked?.ok || !checked.codes) throw new Error(checked?.reason || "编码校验未通过");
  return { ...decision, ...checked.codes };
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

function buildDecisionFromTerm(
  suggestionItem: SuggestionItem,
  ptItem: { code?: string; zh_name?: string; en_name?: string } | null | undefined,
  boundVersion: string,
  boundSourceIdentity: string,
  status: DecisionStatus,
  source: DecisionSource,
  note?: string
): Decision {
  const now = new Date().toISOString();
  if (suggestionItem.level === "PT") {
    return {
      status,
      source,
      meddra_version: boundVersion,
      source_identity: boundSourceIdentity,
      pt_code: suggestionItem.code,
      pt_zh: suggestionItem.zh_name || "",
      pt_en: suggestionItem.en_name || "",
      llt_code: "",
      llt_zh: "",
      llt_en: "",
      llt_is_current: "",
      note,
      updated_at: now,
    };
  }
  return {
    status,
    source,
    meddra_version: boundVersion,
    source_identity: boundSourceIdentity,
    llt_code: suggestionItem.code,
    llt_zh: suggestionItem.zh_name || "",
    llt_en: suggestionItem.en_name || "",
    llt_is_current: suggestionItem.is_current || "",
    pt_code: ptItem?.code || suggestionItem.parent_code || "",
    pt_zh: ptItem?.zh_name || "",
    pt_en: ptItem?.en_name || "",
    note,
    updated_at: now,
  };
}

export default function CodingWorkspace({
  version,
  sourceIdentity,
  mode,
  versionReady,
  apiBase,
  onOpenDetail,
  onRequestSwitchVersion,
  onSessionStateChange,
  onConfirmAction,
  flash,
}: CodingWorkspaceProps) {
  // Volatile in-memory session only: never persist subject/verbatim listings into localStorage.
  const [sessionId, setSessionId] = useState<string>(() => newSessionId());
  const [boundVersion, setBoundVersion] = useState("");
  const [boundSourceIdentity, setBoundSourceIdentity] = useState("");
  const [stats, setStats] = useState<ImportStats | null>(null);
  const [filename, setFilename] = useState("");
  const [targets, setTargets] = useState<ImportResult["coding_targets"]>([]);
  const [terms, setTerms] = useState<UniqueTerm[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [dirty, setDirty] = useState(false);
  const [pendingNativeSaveConfirm, setPendingNativeSaveConfirm] = useState(false);
  const [lastExportedAt, setLastExportedAt] = useState<string | undefined>(undefined);

  const [importing, setImporting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestProgress, setSuggestProgress] = useState<SuggestProgress | null>(null);
  const [failedSuggestTerms, setFailedSuggestTerms] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [filterText, setFilterText] = useState("");
  const [filterStatus, setFilterStatus] = useState<StatusFilterValue>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  const [pasteText, setPasteText] = useState("");
  const [showPasteBox, setShowPasteBox] = useState(false);

  // Manual recode modal state
  const [recodeTarget, setRecodeTarget] = useState<UniqueTerm | null>(null);
  const [recodeQuery, setRecodeQuery] = useState("");
  const [recodeLevels, setRecodeLevels] = useState<Array<"LLT" | "PT">>(["LLT", "PT"]);
  const [recodeSearching, setRecodeSearching] = useState(false);
  const [recodeVerifying, setRecodeVerifying] = useState(false);
  const [recodeResults, setRecodeResults] = useState<SearchResult[]>([]);
  const [recodePicked, setRecodePicked] = useState<VerifiedPair | null>(null);
  const [recodeNote, setRecodeNote] = useState("");
  const [recodeError, setRecodeError] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recodeDialogRef = useRef<HTMLDialogElement | null>(null);
  const sessionIdRef = useRef(sessionId);
  const versionRef = useRef(version);
  const sourceIdentityRef = useRef(sourceIdentity);
  const suggestSeqRef = useRef(0);
  const decisionRequests = useRef(new Map<string, symbol>());
  const suggestAbortRef = useRef<AbortController | null>(null);
  const recodeAbortRef = useRef<AbortController | null>(null);
  const recodeReqRef = useRef(0);
  const pendingNativeExportRef = useRef<{ url: string; ticket: ExportTicket } | null>(null);
  const revisionRef = useRef(0);
  const savedKindsRef = useRef(new Set<ExportKind>());

  sessionIdRef.current = sessionId;
  versionRef.current = version;
  sourceIdentityRef.current = sourceIdentity;

  // Purge any legacy persisted coding drafts on mount to protect subject/verbatim privacy.
  useEffect(() => {
    for (const key of LEGACY_STORAGE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }, []);

  function currentExport(ticket: ExportTicket) {
    return ticket.session === sessionIdRef.current && ticket.revision === revisionRef.current;
  }

  function markExportSaved(ticket: ExportTicket, native: boolean) {
    if (!currentExport(ticket)) return;
    savedKindsRef.current.add(ticket.kind);
    setDirty(ticket.required.some((kind) => !savedKindsRef.current.has(kind)));
    setLastExportedAt(new Date().toLocaleTimeString("zh-CN"));
    setNotice(native ? "文件已保存" : "已发起下载");
  }

  function resetExportTracking() {
    revisionRef.current += 1;
    savedKindsRef.current.clear();
    pendingNativeExportRef.current = null;
    setPendingNativeSaveConfirm(false);
  }

  useEffect(() => {
    const handleNativeDownload = (event: Event) => {
      const pending = pendingNativeExportRef.current;
      if (!pending || pending.url !== (event as CustomEvent<unknown>).detail) return;
      pendingNativeExportRef.current = null;
      URL.revokeObjectURL(pending.url);
      setPendingNativeSaveConfirm(false);
      if (event.type === "meddra:native-download-saved") {
        markExportSaved(pending.ticket, true);
      } else if (currentExport(pending.ticket)) {
        setNotice("保存未完成，可以重新导出");
      }
    };
    window.addEventListener("meddra:native-download-saved", handleNativeDownload);
    window.addEventListener("meddra:native-download-cancelled", handleNativeDownload);
    return () => {
      window.removeEventListener("meddra:native-download-saved", handleNativeDownload);
      window.removeEventListener("meddra:native-download-cancelled", handleNativeDownload);
    };
  }, []);
  // Sync native <dialog> for manual recode
  useEffect(() => {
    const dialog = recodeDialogRef.current;
    if (!dialog) return;
    if (recodeTarget && !dialog.open) {
      dialog.showModal();
    } else if (!recodeTarget && dialog.open) {
      dialog.close();
    }
  }, [recodeTarget]);

  const effectiveVersion = boundVersion || version;
  const effectiveSourceIdentity = boundSourceIdentity || sourceIdentity;
  const versionChanged = Boolean(boundVersion && version && boundVersion !== version);
  const sourceChanged = Boolean(
    boundSourceIdentity &&
      sourceIdentity &&
      !versionChanged &&
      boundSourceIdentity !== sourceIdentity
  );
  const contextUnverified =
    terms.length > 0 &&
    (!versionReady || !boundVersion || !version || !boundSourceIdentity || !sourceIdentity);
  const sessionLockedByContext = versionChanged || sourceChanged || contextUnverified;

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
    let exactBatchEligible = 0;
    let batchAcceptedCount = 0;
    let exportableConfirmed = 0;
    terms.forEach((item) => {
      const decision = decisions[decisionKey(item)];
      const status = decision?.status || "pending";
      if (status === "accepted") accepted += 1;
      else if (status === "edited") edited += 1;
      else if (status === "rejected") rejected += 1;
      else pending += 1;

      if (decision?.source === "batch_exact" && status === "accepted") batchAcceptedCount += 1;
      if (!item.suggestion?.best) noMatch += 1;
      if (status === "pending" && isStrictBatchExactEligible(item)) exactBatchEligible += 1;
      if ((status === "accepted" || status === "edited") && decision?.pt_code && decision?.llt_code && decision?.llt_is_current === "Y") {
        exportableConfirmed += 1;
      }
    });
    return {
      accepted,
      edited,
      rejected,
      pending,
      noMatch,
      exactBatchEligible,
      batchAcceptedCount,
      exportableConfirmed,
      total: terms.length,
    };
  }, [terms, decisions]);

  useEffect(() => {
    onSessionStateChange?.({
      dirty: (dirty || pendingNativeSaveConfirm) && terms.length > 0,
      boundVersion,
      pendingCount: summary.pending,
      totalCount: terms.length,
    });
  }, [dirty, pendingNativeSaveConfirm, boundVersion, summary.pending, terms.length, onSessionStateChange]);

  const visibleTerms = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return terms.filter((item) => {
      if (filterType !== "all" && item.coding_type !== filterType) return false;
      const decision = decisions[decisionKey(item)];
      const status = decision?.status || "pending";
      if (filterStatus === "no_match") {
        if (item.suggestion?.best) return false;
      } else if (filterStatus === "batch_exact") {
        if (!(status === "accepted" && decision?.source === "batch_exact")) return false;
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
        item.suggestion?.pt?.zh_name,
        item.suggestion?.pt?.en_name,
        item.suggestion?.pt?.code,
        decision?.pt_code,
        decision?.pt_zh,
        decision?.pt_en,
        decision?.llt_code,
        decision?.llt_zh,
        decision?.llt_en,
        decision?.note,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [terms, decisions, filterText, filterStatus, filterType]);

  const totalPages = Math.max(1, Math.ceil(visibleTerms.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pagedTerms = useMemo(() => {
    const start = (clampedPage - 1) * pageSize;
    return visibleTerms.slice(start, start + pageSize);
  }, [visibleTerms, clampedPage, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [filterText, filterStatus, filterType, pageSize, sessionId]);

  function askConfirm(config: ConfirmDialogState, fallbackRun: () => void) {
    if (onConfirmAction) {
      onConfirmAction(config);
      return;
    }
    fallbackRun();
  }

  function startNewSessionState(params: {
    nextTerms: UniqueTerm[];
    nextFilename: string;
    nextStats: ImportStats | null;
    nextTargets: ImportResult["coding_targets"];
    nextBoundVersion: string;
    nextBoundSourceIdentity: string;
  }) {
    suggestAbortRef.current?.abort();
    suggestAbortRef.current = null;
    suggestSeqRef.current += 1;
    resetExportTracking();

    const freshSessionId = newSessionId();
    sessionIdRef.current = freshSessionId;
    setSessionId(freshSessionId);
    setBoundVersion(params.nextBoundVersion);
    setBoundSourceIdentity(params.nextBoundSourceIdentity);
    setTerms(params.nextTerms);
    setDecisions({});
    setFilename(params.nextFilename);
    setStats(params.nextStats);
    setTargets(params.nextTargets);
    setFailedSuggestTerms([]);
    setSuggestProgress(null);
    setLastExportedAt(undefined);
    setDirty(params.nextTerms.length > 0);
    setPage(1);
    return freshSessionId;
  }

  async function runSuggestForSession(options: {
    sourceTerms: UniqueTerm[];
    targetTermsFilter?: string[];
    targetVersion: string;
    targetSourceIdentity: string;
    targetMode: Mode;
    targetSessionId: string;
    baseDecisions?: Record<string, Decision>;
  }) {
    const uniqueTermNames = Array.from(
      new Set(
        (options.targetTermsFilter && options.targetTermsFilter.length
          ? options.targetTermsFilter
          : options.sourceTerms.map((item) => item.term)
        ).filter(Boolean)
      )
    );
    if (!uniqueTermNames.length) return;
    if (!versionReady) {
      setError("MedDRA 词典索引尚未就绪，请等待索引完成后再执行自动建议。");
      return;
    }

    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    const seq = ++suggestSeqRef.current;

    const chunks: string[][] = [];
    for (let i = 0; i < uniqueTermNames.length; i += SUGGEST_CHUNK_SIZE) {
      chunks.push(uniqueTermNames.slice(i, i + SUGGEST_CHUNK_SIZE));
    }

    setError("");
    setSuggesting(true);
    setFailedSuggestTerms([]);
    setSuggestProgress({
      completedTerms: 0,
      totalTerms: uniqueTermNames.length,
      currentBatch: 0,
      totalBatches: chunks.length,
    });

    const collectedSuggestions: Record<string, UniqueTerm["suggestion"]> = {};
    const failedChunks: string[] = [];
    let completedCount = 0;

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        if (seq !== suggestSeqRef.current || options.targetSessionId !== sessionIdRef.current) return;
        if (controller.signal.aborted) break;
        const chunk = chunks[i];
        setSuggestProgress({
          completedTerms: completedCount,
          totalTerms: uniqueTermNames.length,
          currentBatch: i + 1,
          totalBatches: chunks.length,
        });
        try {
          const data = await fetchJson<{
            version: string;
            source_signature: string;
            suggestions: Record<string, UniqueTerm["suggestion"]>;
          }>(
            `${apiBase}/coding/suggest`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                terms: chunk,
                version: options.targetVersion || null,
                mode: options.targetMode,
                limit_per_term: 5,
              }),
              signal: controller.signal,
            }
          );
          if (seq !== suggestSeqRef.current || options.targetSessionId !== sessionIdRef.current) {
            return;
          }
          if (data.version !== options.targetVersion || data.source_signature !== options.targetSourceIdentity ||
              sourceIdentityRef.current !== options.targetSourceIdentity) {
            setError("词典版本或索引已变更，请重新生成候选后再审阅。");
            return;
          }
          Object.assign(collectedSuggestions, data.suggestions || {});
        } catch (err) {
          if ((err as DOMException)?.name === "AbortError") {
            break;
          }
          failedChunks.push(...chunk);
        }
        completedCount += chunk.length;
        setSuggestProgress({
          completedTerms: completedCount,
          totalTerms: uniqueTermNames.length,
          currentBatch: i + 1,
          totalBatches: chunks.length,
        });
      }

      if (seq !== suggestSeqRef.current || options.targetSessionId !== sessionIdRef.current) {
        return;
      }

      setTerms((current) => {
        const targetList = current.length ? current : options.sourceTerms;
        return targetList.map((item) => ({
          ...item,
          suggestion: collectedSuggestions[item.term] || item.suggestion,
        }));
      });

      if (options.baseDecisions !== undefined) {
        setDecisions(options.baseDecisions);
      }

      setFailedSuggestTerms(failedChunks);
      const matchedCount = Object.values(collectedSuggestions).filter((item) => item?.best).length;
      if (controller.signal.aborted) {
        setNotice(`已取消后续建议，保留 ${Object.keys(collectedSuggestions).length} 个已完成的术语。`);
      } else if (failedChunks.length) {
        setError(
          `部分批次建议失败（${failedChunks.length} 个术语未完成），已完成 ${Object.keys(collectedSuggestions).length} 个术语。可点击“重试失败批次”。`
        );
      } else {
        setNotice(
          `已在 MedDRA ${options.targetVersion} 生成 ${Object.keys(collectedSuggestions).length} 个术语参考建议（命中 ${matchedCount} 个；全部待人工确认）`
        );
      }
    } finally {
      if (suggestAbortRef.current === controller) {
        suggestAbortRef.current = null;
      }
      if (seq === suggestSeqRef.current) {
        setSuggesting(false);
      }
    }
  }

  async function executeImportFile(file: File) {
    setError("");
    setNotice("");
    const requestedVersion = versionRef.current;
    const requestedIdentity = sourceIdentityRef.current;
    if (!versionReady || !requestedVersion || !requestedIdentity) {
      setError("当前 MedDRA 词典版本或索引来源尚未就绪，请先等待索引完成后再导入 Data Listing。");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setImporting(true);
    try {
      const content = await fileToBase64(file);
      const parsed = await fetchJson<ImportResult>(`${apiBase}/coding/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content_base64: content }),
      });

      const freshId = startNewSessionState({
        nextTerms: parsed.unique_terms,
        nextFilename: parsed.filename,
        nextStats: parsed.stats,
        nextTargets: parsed.coding_targets,
        nextBoundVersion: requestedVersion,
        nextBoundSourceIdentity: requestedIdentity,
      });
      setShowPasteBox(false);
      setNotice(
        `已导入 ${parsed.stats.data_rows} 行（${parsed.stats.target_count} 个待编码列，${parsed.stats.unique_term_count} 个唯一术语），全部处于“待人工确认”`
      );

      if (parsed.stats.unique_term_count > 0 && versionReady && requestedVersion) {
        await runSuggestForSession({
          sourceTerms: parsed.unique_terms,
          targetVersion: requestedVersion,
          targetSourceIdentity: requestedIdentity,
          targetMode: mode,
          targetSessionId: freshId,
          baseDecisions: {},
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleImportClick() {
    if ((dirty || pendingNativeSaveConfirm) && terms.length > 0) {
      askConfirm(
        {
          title: "替换当前编码会话？",
          body: `当前内存会话（${filename || "未命名"}，绑定 MedDRA ${effectiveVersion || "当前"}）存在尚未导出的审阅草稿。导入新 Listing 将开启新会话并丢弃未导出的草稿。`,
          warning: "建议先导出正式编码清单或异常清单，再导入新文件。",
          actions: [
            { label: "取消", onClick: () => {} },
            {
              label: "继续选择文件",
              variant: "danger",
              onClick: () => fileInputRef.current?.click(),
            },
          ],
        },
        () => fileInputRef.current?.click()
      );
      return;
    }
    fileInputRef.current?.click();
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    void executeImportFile(file);
  }

  async function executePasteDryRun() {
    const requestedVersion = versionRef.current;
    const requestedIdentity = sourceIdentityRef.current;
    if (!versionReady || !requestedVersion || !requestedIdentity) {
      setError("当前 MedDRA 词典版本或索引来源尚未就绪，请等待索引完成后再执行干跑。");
      return;
    }
    const lines = pasteText
      .split(/[\n,，;；\t]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      setError("请先粘贴术语列表（每行一个，或用逗号分隔）");
      return;
    }
    const pasted = new Map<string, UniqueTerm>();
    lines.forEach((term, position) => {
      const occurrence = { sheet: "粘贴列表", column: "verbatim", excel_row: position + 1 };
      const previous = pasted.get(term);
      if (previous) {
        previous.count += 1;
        previous.occurrences.push(occurrence);
      } else {
        pasted.set(term, { term, coding_type: "AE", count: 1, occurrences: [occurrence] });
      }
    });
    const nextTerms = [...pasted.values()];
    const freshId = startNewSessionState({
      nextTerms,
      nextFilename: `粘贴列表-${nextTerms.length}词`,
      nextStats: {
        sheet_count: 1,
        data_rows: lines.length,
        target_count: 1,
        unique_term_count: nextTerms.length,
      },
      nextTargets: [{ sheet: "粘贴列表", column: "verbatim", coding_type: "AE", non_empty_count: lines.length }],
      nextBoundVersion: requestedVersion,
      nextBoundSourceIdentity: requestedIdentity,
    });
    setShowPasteBox(false);
    setError("");
    setNotice(`已载入 ${nextTerms.length} 个唯一术语，正在基于 MedDRA ${requestedVersion} 生成参考建议`);
    await runSuggestForSession({
      sourceTerms: nextTerms,
      targetVersion: requestedVersion,
      targetSourceIdentity: requestedIdentity,
      targetMode: mode,
      targetSessionId: freshId,
      baseDecisions: {},
    });
  }

  function runPasteDryRun() {
    if ((dirty || pendingNativeSaveConfirm) && terms.length > 0) {
      askConfirm(
        {
          title: "覆盖当前未导出会话？",
          body: "执行粘贴列表干跑将新建编码会话，并替换当前尚未导出的 Listing 审阅结果。",
          actions: [
            { label: "取消", onClick: () => {} },
            { label: "确认新建干跑", variant: "danger", onClick: () => void executePasteDryRun() },
          ],
        },
        () => void executePasteDryRun()
      );
      return;
    }
    void executePasteDryRun();
  }

  function rebindToCurrentVersionAndSuggest() {
    if (!versionReady || !version) {
      flash?.("请先等待当前 MedDRA 版本索引就绪");
      return;
    }
    askConfirm(
      {
        title: `切换到 MedDRA ${version} 并重置建议？`,
        body: `当前会话绑定在 MedDRA ${boundVersion || "旧版本"}。切换到当前词典状态会把现有人工决定全部重置为“待人工确认”，并用当前索引重新生成参考建议，防止跨版本/跨来源混码。`,
        actions: [
          { label: "取消", onClick: () => {} },
          {
            label: `确认重置并在 ${version} 重跑`,
            variant: "primary",
            onClick: () => {
              const clearedTerms = terms.map((item) => ({ ...item, suggestion: undefined }));
              const sid = startNewSessionState({
                nextTerms: clearedTerms,
                nextFilename: filename,
                nextStats: stats,
                nextTargets: targets,
                nextBoundVersion: version,
                nextBoundSourceIdentity: sourceIdentity,
              });
              void runSuggestForSession({
                sourceTerms: clearedTerms,
                targetVersion: version,
                targetSourceIdentity: sourceIdentity,
                targetMode: mode,
                targetSessionId: sid,
                baseDecisions: {},
              });
            },
          },
        ],
      },
      () => {}
    );
  }

  function applyDecision(item: UniqueTerm, decision: Decision) {
    if (sessionLockedByContext) {
      flash?.("当前词典版本或来源索引未验证或已变更，请先切回原版本或重置后重跑建议");
      return;
    }
    resetExportTracking();
    decisionRequests.current.delete(decisionKey(item));
    setDecisions((prev) => ({ ...prev, [decisionKey(item)]: decision }));
    setDirty(true);
  }

  async function confirmCandidate(item: UniqueTerm, candidate?: SuggestionItem | null, alternative = false) {
    if (sessionLockedByContext || !candidate) return;
    if (candidate.level === "PT") {
      openRecodeModal(item, candidate.code);
      return;
    }
    if (candidate.level !== "LLT" || candidate.is_current !== "Y") {
      flash?.("请选择当前 LLT。");
      return;
    }
    const session = sessionIdRef.current;
    const key = decisionKey(item);
    const request = Symbol();
    decisionRequests.current.set(key, request);
    const directPt = candidate.pt || (item.suggestion?.pt?.code === candidate.parent_code ? item.suggestion?.pt : null);
    const decision = buildDecisionFromTerm(
      candidate, directPt, boundVersion, boundSourceIdentity,
      alternative ? "edited" : "accepted", alternative ? "candidate" : "accept_best"
    );
    try {
      const checked = await validateCodingDecisionWithBackend(apiBase, boundVersion, boundSourceIdentity, decision);
      if (session !== sessionIdRef.current || sourceIdentityRef.current !== boundSourceIdentity ||
          decisionRequests.current.get(key) !== request) return;
      applyDecision(item, checked);
    } catch (error) {
      if (session === sessionIdRef.current && decisionRequests.current.get(key) === request) {
        flash?.(error instanceof Error ? error.message : "编码校验失败");
      }
    } finally {
      if (decisionRequests.current.get(key) === request) decisionRequests.current.delete(key);
    }
  }

  function rejectTerm(item: UniqueTerm) {
    const existing = decisions[decisionKey(item)];
    applyDecision(item, {
      status: "rejected",
      source: "rejected",
      meddra_version: effectiveVersion,
      source_identity: effectiveSourceIdentity,
      note: existing?.note || "",
      updated_at: new Date().toISOString(),
    });
  }

  function resetTerm(item: UniqueTerm) {
    applyDecision(item, { status: "pending", source: "pending", updated_at: new Date().toISOString() });
  }

  function executeBatchExactAccept() {
    if (sessionLockedByContext) {
      flash?.("当前词典版本或来源索引已变更，请先切回原版本或重置后重跑建议");
      return;
    }
    const next = { ...decisions };
    let count = 0;
    const targetVer = boundVersion || effectiveVersion;
    const targetIdentity = boundSourceIdentity || effectiveSourceIdentity;
    terms.forEach((item) => {
      const key = decisionKey(item);
      const currentStatus = next[key]?.status;
      if (currentStatus === "accepted" || currentStatus === "edited" || currentStatus === "rejected") return;
      if (isStrictBatchExactEligible(item) && item.suggestion?.best) {
        next[key] = buildDecisionFromTerm(
          item.suggestion.best,
          item.suggestion.pt,
          targetVer,
          targetIdentity,
          "accepted",
          "batch_exact"
        );
        count += 1;
      }
    });
    resetExportTracking();
    setDecisions(next);
    setDirty(true);
    setFilterStatus("batch_exact");
    flash?.(`已人工批量确认 ${count} 个同字面唯一当前精确匹配，已切至可回看筛选`);
  }

  function requestBatchExactAccept() {
    if (sessionLockedByContext) {
      flash?.("当前词典版本或来源索引已变更，请先切回原版本或重置后重跑建议");
      return;
    }
    const eligibleItems = terms.filter((item) => {
      const currentStatus = decisions[decisionKey(item)]?.status;
      if (currentStatus === "accepted" || currentStatus === "edited" || currentStatus === "rejected") return false;
      return isStrictBatchExactEligible(item);
    });
    if (!eligibleItems.length) {
      flash?.("没有符合“同字面·唯一·当前·已验证父PT”条件的待审条目");
      return;
    }
    const preview = eligibleItems
      .slice(0, 5)
      .map((item) => item.term)
      .join("、");
    askConfirm(
      {
        title: `确认批量接受 ${eligibleItems.length} 个精确匹配？`,
        body: `仅包含同时满足【同字面（区分大小写）·唯一候选·当前术语·已验证父级PT】的条目（示例：${preview}${
          eligibleItems.length > 5 ? " 等" : ""
        }）。非当前 LLT、大小写差异、多候选或无父级 PT 的条目已自动排除。`,
        warning: "确认后可通过状态筛选“仅看批量精确确认”逐条回看或改码。",
        actions: [
          { label: "取消", onClick: () => {} },
          {
            label: `确认接受 ${eligibleItems.length} 条并回看`,
            variant: "primary",
            onClick: executeBatchExactAccept,
          },
        ],
      },
      executeBatchExactAccept
    );
  }

  // ===== Manual Recode Modal Handlers =====
  function openRecodeModal(item: UniqueTerm, code = item.term) {
    if (sessionLockedByContext) {
      flash?.("当前词典版本或来源索引已变更，请先切回原版本或重置后重跑建议");
      return;
    }
    const existing = decisions[decisionKey(item)];
    setRecodeTarget(item);
    setRecodeQuery(code);
    setRecodeLevels(["LLT", "PT"]);
    setRecodeResults([]);
    setRecodeError("");
    setRecodeNote(existing?.note || "");
    if (existing?.pt_code) {
      setRecodePicked({
        level: existing.llt_code ? "LLT" : "PT",
        code: existing.llt_code || existing.pt_code,
        en_name: (existing.llt_code ? existing.llt_en : existing.pt_en) || "",
        zh_name: (existing.llt_code ? existing.llt_zh : existing.pt_zh) || "",
        is_current: existing.llt_is_current || "Y",
        pt_code: existing.pt_code,
        pt_zh: existing.pt_zh || "",
        pt_en: existing.pt_en || "",
      });
    } else {
      setRecodePicked(null);
    }
    if (versionReady && effectiveVersion) {
      void searchInRecodeModal(code, ["LLT", "PT"], effectiveVersion);
    }
  }

  function closeRecodeModal() {
    recodeReqRef.current += 1;
    setRecodeVerifying(false);
    setRecodeSearching(false);
    recodeAbortRef.current?.abort();
    recodeAbortRef.current = null;
    setRecodeTarget(null);
    setRecodePicked(null);
    setRecodeResults([]);
    setRecodeError("");
  }

  async function searchInRecodeModal(
    searchText = recodeQuery,
    levels: Array<"LLT" | "PT"> = recodeLevels,
    targetVer = effectiveVersion
  ) {
    const q = searchText.trim();
    if (!q) return;
    if (!targetVer || !versionReady) {
      setRecodeError("当前词典版本尚未就绪，无法检索核对术语。");
      return;
    }
    recodeAbortRef.current?.abort();
    const controller = new AbortController();
    recodeAbortRef.current = controller;
    const reqId = ++recodeReqRef.current;
    setRecodeSearching(true);
    setRecodeError("");
    try {
      if (/^\d{2,}$/.test(q)) {
        const data = await fetchJson<{ matches?: Detail[] }>(
          apiPathWithVersion(apiBase, `/code/${encodeURIComponent(q)}`, targetVer),
          { signal: controller.signal }
        );
        if (reqId !== recodeReqRef.current) return;
        const rows = (data.matches || [])
          .filter((d) => d.term && (d.term.level === "PT" || d.term.level === "LLT"))
          .map((d) => ({
            level: d.term!.level,
            level_label: d.level_label || d.term!.level,
            code: d.term!.code,
            en_name: d.term!.en_name,
            zh_name: d.term!.zh_name,
            is_current: d.term!.is_current,
            category: "code",
            category_label: "代码匹配",
            matched_field: "代码",
            score: 100,
            reason: "代码核对结果",
          }));
        setRecodeResults(rows);
        return;
      }

      const data = await fetchJson<{ groups?: Array<{ results: SearchResult[] }> }>(`${apiBase}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          version: targetVer,
          mode,
          levels,
          soc_codes: [],
          include_synonyms: true,
          ignore_diacritics: true,
          include_non_current: true,
          limit_per_group: 25,
        }),
        signal: controller.signal,
      });
      if (reqId !== recodeReqRef.current) return;
      const flat = (data.groups || []).flatMap((g) => g.results || []);
      setRecodeResults(flat);
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError" && reqId === recodeReqRef.current) {
        setRecodeError(err instanceof Error ? err.message : "检索失败");
      }
    } finally {
      if (reqId === recodeReqRef.current) setRecodeSearching(false);
    }
  }

  async function verifyAndPickRecodeTerm(level: string, code: string) {
    if (level !== "LLT" && level !== "PT") return;
    if (!effectiveVersion) return;
    const reqId = ++recodeReqRef.current;
    setRecodeVerifying(true);
    setRecodeError("");
    try {
      const data = await fetchJson<Detail>(
        apiPathWithVersion(apiBase, `/details/${level}/${encodeURIComponent(code)}`, effectiveVersion)
      );
      if (reqId !== recodeReqRef.current) return;
      if (!data.found || !data.term) {
        setRecodeError(`在 MedDRA ${effectiveVersion} 中未找到 ${level} ${code}`);
        return;
      }
      const term = data.term;
      const paths = data.relationships?.hierarchy_paths || data.hierarchies || [];
      const primary = paths.find((row) => row.primary_soc === "Y") || paths[0];
      const primarySocName = primary
        ? displayNameOf({ en_name: primary.en_soc_name, zh_name: primary.zh_soc_name }, mode)
        : undefined;

      if (term.level === "PT") {
        const resolved = await resolveCurrentLltsForPt(apiBase, term.code, effectiveVersion, mode);
        if (reqId !== recodeReqRef.current) return;
        if (!resolved.currentLlts.length || !resolved.preferred) {
          setRecodePicked(null);
          setRecodeError(`PT ${term.code} 下未找到任何当前 (Current) LLT，请直接检索并选择当前 LLT。`);
          return;
        }
        setRecodePicked({
          level: "LLT",
          code: resolved.preferred.code,
          en_name: resolved.preferred.en_name || resolved.preferred.display_name || "",
          zh_name: resolved.preferred.zh_name || "",
          is_current: "Y",
          pt_code: term.code,
          pt_zh: term.zh_name,
          pt_en: term.en_name,
          primary_soc: primarySocName || resolved.primarySoc,
          pairedCurrentLlts: resolved.currentLlts,
        });
        return;
      }

      if (term.is_current !== "Y") {
        setRecodePicked(null);
        setRecodeError(
          `LLT ${term.code}（${displayNameOf(term, mode)}）为非当前术语 (Non-current)，按规范不可确认为正式编码；请选择同一父级 PT 下的当前 LLT。`
        );
        return;
      }

      let ptCode = primary?.pt_code || term.parent_code || "";
      let ptZh = primary?.zh_pt_name || "";
      let ptEn = primary?.en_pt_name || "";
      if (ptCode && (!ptZh && !ptEn)) {
        const ptDetail = await fetchJson<Detail>(
          apiPathWithVersion(apiBase, `/details/PT/${encodeURIComponent(ptCode)}`, effectiveVersion)
        );
        if (reqId !== recodeReqRef.current) return;
        if (ptDetail.found && ptDetail.term) {
          ptCode = ptDetail.term.code;
          ptZh = ptDetail.term.zh_name;
          ptEn = ptDetail.term.en_name;
        }
      }
      if (!ptCode) {
        setRecodePicked(null);
        setRecodeError(`LLT ${term.code} 缺少有效父级 PT，无法保存不一致编码。`);
        return;
      }
      setRecodePicked({
        level: "LLT",
        code: term.code,
        en_name: term.en_name,
        zh_name: term.zh_name,
        is_current: "Y",
        pt_code: ptCode,
        pt_zh: ptZh,
        pt_en: ptEn,
        primary_soc: primarySocName,
      });
    } catch (err) {
      if (reqId === recodeReqRef.current) {
        setRecodeError(err instanceof Error ? err.message : "校验术语父子关系失败");
      }
    } finally {
      if (reqId === recodeReqRef.current) setRecodeVerifying(false);
    }
  }

  async function saveManualRecode() {
    if (sessionLockedByContext) {
      flash?.("当前词典版本或来源索引未验证或已变更，请先切回原版本或重置后重跑建议");
      return;
    }
    if (!recodeTarget || !recodePicked || !recodePicked.pt_code || !recodePicked.code || recodePicked.is_current !== "Y") {
      setRecodeError("正式编码必须包含有效的当前 (Current) LLT 与对应父级 PT。");
      return;
    }
    const targetSession = sessionIdRef.current;
    const reqId = ++recodeReqRef.current;
    const targetVer = boundVersion || effectiveVersion;
    const targetIdentity = boundSourceIdentity || effectiveSourceIdentity;
    const now = new Date().toISOString();
    const nextDecision: Decision = {
      status: "edited",
      source: "manual_edit",
      meddra_version: targetVer,
      source_identity: targetIdentity,
      pt_code: recodePicked.pt_code,
      pt_zh: recodePicked.pt_zh,
      pt_en: recodePicked.pt_en,
      llt_code: recodePicked.code,
      llt_zh: recodePicked.zh_name,
      llt_en: recodePicked.en_name,
      llt_is_current: "Y",
      note: recodeNote.trim(),
      updated_at: now,
    };
    setRecodeVerifying(true);
    setRecodeError("");
    try {
      const checked = await validateCodingDecisionWithBackend(apiBase, targetVer, targetIdentity, nextDecision);
      if (reqId !== recodeReqRef.current || targetSession !== sessionIdRef.current ||
          sourceIdentityRef.current !== targetIdentity) return;
      applyDecision(recodeTarget, checked);
      flash?.(`已人工改码为 LLT ${recodePicked.code}（PT ${recodePicked.pt_code}）`);
      closeRecodeModal();
    } catch (error) {
      if (reqId === recodeReqRef.current) setRecodeError(error instanceof Error ? error.message : "编码校验失败");
    } finally {
      if (reqId === recodeReqRef.current) setRecodeVerifying(false);
    }
  }

  // ===== Dual Exports (Official Coded vs Unified Backend Exceptions) =====
  function beginExport(kind: ExportKind): ExportTicket {
    const required: ExportKind[] = [];
    if (summary.exportableConfirmed) required.push("coded");
    if (terms.length > summary.exportableConfirmed) required.push("exceptions");
    return { kind, required, revision: revisionRef.current, session: sessionIdRef.current };
  }

  function submitDownload(filename: string, blob: Blob, ticket: ExportTicket) {
    if (!currentExport(ticket)) throw new Error("审阅内容已更新，请重新导出。");
    const url = downloadBlobDeferred(filename, blob);
    if (isNativeWkWebView()) {
      pendingNativeExportRef.current = { url, ticket };
      setPendingNativeSaveConfirm(true);
    } else {
      markExportSaved(ticket, false);
    }
  }

  async function executeOfficialExport() {
    if (
      sessionLockedByContext ||
      !versionReady ||
      !boundVersion ||
      version !== boundVersion ||
      !boundSourceIdentity ||
      sourceIdentity !== boundSourceIdentity
    ) {
      setError("当前词典版本或来源索引未验证/已变更，已阻止旧决定导出，请切回原版本或重置后重跑建议。");
      return;
    }
    const ticket = beginExport("coded");
    const confirmedTerms = terms.filter((item) => {
      const dec = decisions[decisionKey(item)];
      return (
        (dec?.status === "accepted" || dec?.status === "edited") &&
        Boolean(dec.pt_code) &&
        Boolean(dec.llt_code) &&
        dec.llt_is_current === "Y" &&
        Boolean(dec.meddra_version) &&
        dec.meddra_version === boundVersion &&
        Boolean(dec.source_identity) &&
        dec.source_identity === boundSourceIdentity
      );
    });
    if (!confirmedTerms.length) {
      setError("尚无已人工确认（接受/改码）且当前 LLT 与父级 PT 完整一致的条目，无法导出正式编码清单。");
      return;
    }

    setError("");
    setExporting(true);
    const safeVersionSlug = boundVersion.replace(/[^0-9A-Za-z._-]+/g, "_");
    const baseStem = (filename || "listing").replace(/\.[^.]+$/, "");
    const apiAsciiFilename = `meddra_coded_v${safeVersionSlug}.csv`;
    const localDownloadFilename = `meddra_coded_v${safeVersionSlug}_${baseStem}.csv`;

    const versionedDecisions: Record<string, Decision> = {};
    confirmedTerms.forEach((item) => {
      const key = decisionKey(item);
      const dec = decisions[key];
      const verTag = `MedDRA ${boundVersion}`;
      const noteText = [verTag, dec.note].filter(Boolean).join(" | ");
      versionedDecisions[key] = { ...dec, note: noteText };
    });

    try {
      const response = await fetch(`${apiBase}/coding/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unique_terms: confirmedTerms,
          decisions: versionedDecisions,
          filename: apiAsciiFilename,
          dictionary_version: boundVersion,
          source_signature: boundSourceIdentity,
          export_mode: "coded",
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message || "导出失败");
      }
      const blob = await response.blob();
      if (sourceIdentityRef.current !== boundSourceIdentity) throw new Error("词典索引已更新，请重新导出。");
      submitDownload(localDownloadFilename, blob, ticket);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  function handleOfficialExportClick() {
    if (
      sessionLockedByContext ||
      !versionReady ||
      !boundVersion ||
      version !== boundVersion ||
      !boundSourceIdentity ||
      sourceIdentity !== boundSourceIdentity
    ) {
      setError("当前词典版本或索引来源未验证/已变更，已阻止跨版本或跨索引导出。");
      return;
    }
    const unconfirmedCount = terms.length - summary.exportableConfirmed;
    if (unconfirmedCount > 0) {
      askConfirm(
        {
          title: "确认仅导出已人工确认条目？",
          body: `正式编码清单将仅包含 ${summary.exportableConfirmed} 个已人工接受或改码的条目（共 ${terms.length} 个唯一术语）。其余 ${unconfirmedCount} 个待审/已拒绝条目不会进入正式编码清单，可通过“导出异常清单”单独核查。`,
          actions: [
            { label: "返回继续审阅", onClick: () => {} },
            { label: `导出正式清单 (${summary.exportableConfirmed})`, variant: "primary", onClick: () => void executeOfficialExport() },
          ],
        },
        () => void executeOfficialExport()
      );
      return;
    }
    void executeOfficialExport();
  }

  async function handleExceptionExportClick() {
    const ticket = beginExport("exceptions");
    const exceptionItems = terms.filter((item) => {
      const dec = decisions[decisionKey(item)];
      const status = dec?.status || "pending";
      const isCompleteConfirmed =
        (status === "accepted" || status === "edited") &&
        Boolean(dec?.pt_code) &&
        Boolean(dec?.llt_code) &&
        dec?.llt_is_current === "Y";
      return !isCompleteConfirmed;
    });

    if (!exceptionItems.length) {
      flash?.("当前没有待审或已拒绝的异常条目");
      return;
    }

    const safeVersionSlug = (boundVersion || version || "meddra").replace(/[^0-9A-Za-z._-]+/g, "_");
    const baseStem = (filename || "listing").replace(/\.[^.]+$/, "");
    const apiAsciiExceptionFilename = `meddra_exceptions_v${safeVersionSlug}.csv`;
    const localExceptionFilename = `meddra_exceptions_v${safeVersionSlug}_${baseStem}.csv`;

    // Strip all unconfirmed suggestion codes before requesting unified backend exception export.
    const strippedTerms = exceptionItems.map((item) => ({
      term: item.term,
      coding_type: item.coding_type,
      count: item.count,
      occurrences: item.occurrences,
    }));
    const strippedDecisions: Record<string, { status: DecisionStatus; note: string }> = {};
    exceptionItems.forEach((item) => {
      const key = decisionKey(item);
      const dec = decisions[key];
      const status: DecisionStatus = dec?.status === "rejected" ? "rejected" : "pending";
      strippedDecisions[key] = { status, note: dec?.note || "" };
    });

    setError("");
    setExporting(true);
    try {
      const response = await fetch(`${apiBase}/coding/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unique_terms: strippedTerms,
          decisions: strippedDecisions,
          filename: apiAsciiExceptionFilename,
          export_mode: "exceptions",
        }),
      });
      if (response.status === 409) {
        throw new Error("当前词典索引签名已变更（HTTP 409），请刷新并确认会话上下文后重试。");
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload?.detail === "string" ? payload.detail : "异常清单导出失败");
      }
      submitDownload(localExceptionFilename, await response.blob(), ticket);
    } catch (err) {
      setError(err instanceof Error ? err.message : "异常清单导出失败");
    } finally {
      setExporting(false);
    }
  }

  function clearSession() {
    const doClear = () => {
      suggestAbortRef.current?.abort();
      suggestAbortRef.current = null;
      suggestSeqRef.current += 1;
      resetExportTracking();
      setSessionId(newSessionId());
      setBoundVersion("");
      setBoundSourceIdentity("");
      setTerms([]);
      setDecisions({});
      setStats(null);
      setTargets([]);
      setFilename("");
      setNotice("");
      setError("");
      setDirty(false);
      setLastExportedAt(undefined);
      setFailedSuggestTerms([]);
      setSuggestProgress(null);
    };
    if ((dirty || pendingNativeSaveConfirm) && terms.length > 0) {
      askConfirm(
        {
          title: "清空当前编码会话？",
          body: "当前列表存在尚未导出的审阅决定，清空后将不可恢复。",
          actions: [
            { label: "取消", onClick: () => {} },
            { label: "确认清空", variant: "danger", onClick: doClear },
          ],
        },
        doClear
      );
      return;
    }
    doClear();
  }

  const statusFilterOptions: Array<{ value: StatusFilterValue; label: string }> = [
    { value: "all", label: "全部状态" },
    { value: "pending", label: "待人工确认" },
    { value: "accepted", label: "人工接受" },
    { value: "batch_exact", label: `仅看批量精确 (${summary.batchAcceptedCount})` },
    { value: "edited", label: "人工改码" },
    { value: "rejected", label: "人工拒绝" },
    { value: "no_match", label: "无建议" },
  ];

  const exceptionCount = terms.length - summary.exportableConfirmed;

  return (
    <section className="module coding-module">
      <div className="coding-hero kz-card">
        <h2>编码审阅</h2>
        <div className="coding-hero-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xlsm,.csv"
            onChange={onFileChange}
            hidden
            aria-label="选择 Data Listing 文件"
          />
          <button className="kz-btn primary" disabled={importing || suggesting} onClick={handleImportClick}>
            {importing ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
            导入 Listing
          </button>
          <button
            className="kz-btn"
            disabled={importing || suggesting}
            onClick={() => setShowPasteBox((v) => !v)}
          >
            粘贴列表干跑
          </button>
          <button
            className="kz-btn"
            disabled={suggesting || !terms.length || !versionReady || sessionLockedByContext}
            onClick={() =>
              void runSuggestForSession({
                sourceTerms: terms,
                targetVersion: effectiveVersion,
                targetSourceIdentity: effectiveSourceIdentity,
                targetMode: mode,
                targetSessionId: sessionId,
              })
            }
          >
            {suggesting ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
            重新建议
          </button>
          <button
            className="kz-btn"
            disabled={!terms.length || !summary.exactBatchEligible || sessionLockedByContext}
            onClick={requestBatchExactAccept}
          >
            <Check size={15} /> 批量接受精确匹配 ({summary.exactBatchEligible})
          </button>
          <button
            className="kz-btn primary"
            disabled={exporting || pendingNativeSaveConfirm || !summary.exportableConfirmed || sessionLockedByContext}
            onClick={handleOfficialExportClick}
          >
            {exporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
            导出正式编码清单 ({summary.exportableConfirmed})
          </button>
          <button className="kz-btn" disabled={exporting || pendingNativeSaveConfirm || !exceptionCount} onClick={() => void handleExceptionExportClick()}>
            <Download size={15} /> 导出异常清单 ({exceptionCount})
          </button>
          <button className="kz-btn ghost" disabled={!terms.length} onClick={clearSession}>
            <RotateCcw size={15} /> 清空会话
          </button>
        </div>
      </div>

      {!versionReady && (
        <div className="coding-banner warn" role="status">
          <span className="coding-banner-text">
            <AlertTriangle size={14} /> MedDRA 词典索引尚未就绪，请先在「设置」中绑定词典并等待索引完成。
          </span>
        </div>
      )}

      {sessionLockedByContext && (
        <div className="coding-banner warn" role="alert">
          <span className="coding-banner-text">
            <AlertTriangle size={15} />
            <strong>
              {versionChanged
                ? `版本锁定提醒：当前会话绑定 MedDRA ${boundVersion}，顶部已切换为 MedDRA ${version}。已阻止旧决定修改与导出。`
                : sourceChanged
                  ? `索引来源变更提醒：当前 MedDRA ${effectiveVersion} 词典来源或索引签名已更新，已阻止旧决定修改与导出。`
                  : `失败安全锁定：当前词典版本或来源索引尚未完成校验，已暂停决定修改与正式导出。`}
            </strong>
          </span>
          <div className="coding-hero-actions">
            {versionChanged && onRequestSwitchVersion && (
              <button className="kz-btn primary" type="button" onClick={() => onRequestSwitchVersion(boundVersion)}>
                切回 MedDRA {boundVersion}
              </button>
            )}
            <button
              className="kz-btn"
              type="button"
              disabled={!versionReady || !version || !sourceIdentity}
              onClick={rebindToCurrentVersionAndSuggest}
            >
              重置决定并在 {version || "当前版本"} 重跑建议
            </button>
          </div>
        </div>
      )}

      {suggesting && suggestProgress && (
        <div className="coding-progress-strip" aria-live="polite">
          <span>
            正在生成候选 · 已处理{" "}
            {suggestProgress.completedTerms} / {suggestProgress.totalTerms} 个术语
          </span>
          <div className="index-progress-meter">
            <span
              style={{
                width: `${Math.round((suggestProgress.completedTerms * 100) / Math.max(1, suggestProgress.totalTerms))}%`,
              }}
            />
          </div>
          <button className="mini" type="button" onClick={() => suggestAbortRef.current?.abort()}>
            取消建议
          </button>
        </div>
      )}

      {failedSuggestTerms.length > 0 && !suggesting && (
        <div className="coding-banner error" role="alert">
          <span className="coding-banner-text">
            <X size={14} /> 有 {failedSuggestTerms.length} 个术语建议请求失败（已完成部分已保留）。
          </span>
          <button
            className="kz-btn"
            type="button"
            disabled={!versionReady || sessionLockedByContext}
            onClick={() =>
              void runSuggestForSession({
                sourceTerms: terms,
                targetTermsFilter: failedSuggestTerms,
                targetVersion: effectiveVersion,
                targetSourceIdentity: effectiveSourceIdentity,
                targetMode: mode,
                targetSessionId: sessionId,
              })
            }
          >
            重试失败批次 ({failedSuggestTerms.length})
          </button>
        </div>
      )}

      {error && !failedSuggestTerms.length && (
        <div className="coding-banner error" role="alert">
          <span className="coding-banner-text">
            <X size={14} /> {error}
          </span>
        </div>
      )}

      {!suggesting && !error && (notice || dirty || pendingNativeSaveConfirm) && (
        <div className="coding-banner info" role="status">
          <span className="coding-banner-text">{pendingNativeSaveConfirm ? "等待系统保存确认" : notice || "草稿仅保存在当前页面"}</span>
          {dirty && <span className="verbatim-sub" title="关闭或刷新页面会清除草稿">未导出草稿</span>}
          {lastExportedAt && <span className="verbatim-sub">最近导出 {lastExportedAt}</span>}
        </div>
      )}

      {showPasteBox && terms.length > 0 && (
        <div className="kz-card" style={{ padding: "10px 12px", borderRadius: "12px" }}>
          <div className="coding-paste-box" style={{ marginTop: 0, width: "100%" }}>
            <label htmlFor="coding-paste-inline">新建粘贴列表干跑（每行一个术语，将新建会话）</label>
            <textarea
              id="coding-paste-inline"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={3}
              placeholder={"头痛\n高血压\n过敏性结膜炎\nrh incompatibility"}
            />
            <div className="coding-hero-actions">
              <button
                className="kz-btn primary"
                disabled={suggesting || !pasteText.trim() || !versionReady}
                onClick={runPasteDryRun}
              >
                执行粘贴干跑
              </button>
              <button className="kz-btn" type="button" onClick={() => setShowPasteBox(false)}>
                收起
              </button>
            </div>
          </div>
        </div>
      )}

      {stats && (
        <div className="kz-stat-strip kz-card" data-component="stat-strip">
          <div className="kz-stat">
            <span className="kz-stat-label">文件</span>
            <span className="kz-stat-value kz-stat-text" title={filename}>
              {filename}
            </span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">绑定词典</span>
            <span className="kz-stat-value kz-stat-text">MedDRA {boundVersion || version || "未绑定"}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">唯一术语 / 行</span>
            <span className="kz-stat-value">
              {stats.unique_term_count} / {stats.data_rows}
            </span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">人工接受</span>
            <span className="kz-stat-value accent">{summary.accepted}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">人工改码</span>
            <span className="kz-stat-value">{summary.edited}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">待确认</span>
            <span className="kz-stat-value">{summary.pending}</span>
          </div>
          <div className="kz-stat">
            <span className="kz-stat-label">已拒绝 / 无建议</span>
            <span className="kz-stat-value risk">
              {summary.rejected} / {summary.noMatch}
            </span>
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
        <div className="kz-empty coding-empty kz-card">
          <FileSpreadsheet size={26} />
          <p>尚未导入 Data Listing</p>
          <p className="coding-empty-hint">
            支持多 Sheet Excel（xlsx / xlsm）及 CSV，自动识别 AETERM、MHTERM、CMINDC、AHDESC、ALRTERM、DSDECOD。草稿仅保存在当前内存会话中，不写入持久化本地存储。
          </p>
          <div className="coding-paste-box">
            <label htmlFor="coding-paste">或直接粘贴术语列表（每行一个，用于干跑建议）</label>
            <textarea
              id="coding-paste"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={4}
              placeholder={"头痛\n高血压\n过敏性结膜炎\nrh incompatibility"}
            />
            <button
              className="kz-btn primary"
              disabled={suggesting || !pasteText.trim() || !versionReady}
              onClick={runPasteDryRun}
            >
              {suggesting ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
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
              placeholder="筛选原文 / PT / LLT / 代码 / 备注"
              aria-label="筛选术语"
            />
            <select
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value as StatusFilterValue)}
              aria-label="按状态筛选"
            >
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
              筛选命中 {visibleTerms.length} / {terms.length} · 绑定 MedDRA {boundVersion || version || "—"}
            </span>
          </div>

          <div className="coding-table-wrap kz-card" data-density="ultra">
            <table className="coding-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>原文术语 (Verbatim)</th>
                  <th>次</th>
                  <th>PT (首选语)</th>
                  <th>LLT (低位语)</th>
                  <th>匹配参考</th>
                  <th>审阅状态</th>
                  <th>人工审阅操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedTerms.map((item) => {
                  const key = decisionKey(item);
                  const decision = decisions[key];
                  const status = decision?.status || "pending";
                  const best = item.suggestion?.best;
                  const pt = item.suggestion?.pt || (best?.level === "PT" ? best : null);
                  const llt = best?.level === "LLT" ? best : null;

                  const confirmedPtName =
                    decision?.pt_code && (status === "accepted" || status === "edited")
                      ? displayNameOf({ zh_name: decision.pt_zh, en_name: decision.pt_en }, mode)
                      : displayNameOf(pt, mode);
                  const confirmedPtCode =
                    decision?.pt_code && (status === "accepted" || status === "edited")
                      ? decision.pt_code
                      : pt?.code || "";

                  const confirmedLltName =
                    decision?.llt_code && (status === "accepted" || status === "edited")
                      ? displayNameOf({ zh_name: decision.llt_zh, en_name: decision.llt_en }, mode)
                      : displayNameOf(llt, mode);
                  const confirmedLltCode =
                    decision?.llt_code && (status === "accepted" || status === "edited")
                      ? decision.llt_code
                      : llt?.code || "";
                  const lltCurrentFlag =
                    decision?.llt_code && (status === "accepted" || status === "edited")
                      ? decision.llt_is_current
                      : llt?.is_current;

                  const caseDiff = hasCaseDifference(item.term, best) || hasCaseDifference(item.term, pt);
                  const sampleOcc = item.occurrences?.[0];
                  const occTitle = sampleOcc
                    ? `示例位置：${sampleOcc.sheet || ""} ${sampleOcc.column || ""} 行 ${sampleOcc.excel_row ?? ""}`
                    : item.term;

                  return (
                    <tr key={key} className={`status-${status}`}>
                      <td>
                        <span className={`type-badge type-${item.coding_type}`}>{item.coding_type}</span>
                      </td>
                      <td className="term-cell" title={occTitle}>
                        <div className="verbatim-wrap">
                          <span>{item.term}</span>
                          {caseDiff && (
                            <span
                              className="case-diff-badge"
                              title="原文与英文词典条目的大小写不一致，请核对医学语义（如 Rh 等专有名词）"
                            >
                              大小写差异
                            </span>
                          )}
                          {decision?.source === "batch_exact" && status === "accepted" && (
                            <span className="verbatim-sub">来源：批量精确确认</span>
                          )}
                          {decision?.note && <span className="verbatim-sub">备注: {decision.note}</span>}
                        </div>
                      </td>
                      <td className="num-cell">{item.count}</td>
                      <td className="code-cell">
                        {confirmedPtCode || confirmedPtName ? (
                          <div className="code-cell-primary">
                            <span>{confirmedPtName || "—"}</span>
                            <span className="code-cell-code">
                              {confirmedPtCode}
                              {status === "pending" ? "（待确认）" : ""}
                            </span>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="code-cell">
                        {confirmedLltCode || confirmedLltName ? (
                          <div className="code-cell-primary">
                            <span>{confirmedLltName || "—"}</span>
                            <span className="code-cell-code">
                              {confirmedLltCode}
                              {lltCurrentFlag === "N" && (
                                <>
                                  {" "}
                                  <span className="non-current-pill">非当前LLT</span>
                                </>
                              )}
                            </span>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
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
                        <button
                          className="mini primary"
                          type="button"
                          onClick={() => void confirmCandidate(item, best)}
                          disabled={
                            !best ||
                            (best.level === "LLT" && best.is_current !== "Y") ||
                            status === "accepted" ||
                            sessionLockedByContext
                          }
                          title={
                            best?.level === "LLT" && best.is_current !== "Y"
                              ? "非当前 LLT 不可直接确认，请点击「改码」选用当前 LLT"
                              : undefined
                          }
                        >
                          {best?.level === "PT" ? "选 LLT" : "接受"}
                        </button>
                        <button
                          className="mini"
                          type="button"
                          onClick={() => openRecodeModal(item)}
                          disabled={sessionLockedByContext}
                        >
                          <Edit3 size={11} /> 改码
                        </button>
                        <button
                          className="mini"
                          type="button"
                          onClick={() => rejectTerm(item)}
                          disabled={status === "rejected" || sessionLockedByContext}
                        >
                          拒绝
                        </button>
                        <button
                          className="mini"
                          type="button"
                          onClick={() => resetTerm(item)}
                          disabled={status === "pending" || sessionLockedByContext}
                        >
                          重置
                        </button>
                        {(item.suggestion?.candidates?.length || 0) > 1 && (
                          <details className="candidate-details">
                            <summary>候选({item.suggestion?.candidates?.length})</summary>
                            <ul>
                              {(item.suggestion?.candidates || []).slice(0, 6).map((candidate) => (
                                <li key={`${candidate.level}:${candidate.code}`}>
                                  <button
                                    type="button"
                                    disabled={
                                      sessionLockedByContext ||
                                      (candidate.level === "LLT" && candidate.is_current !== "Y")
                                    }
                                    onClick={() => void confirmCandidate(item, candidate, true)}
                                    title={
                                      candidate.level === "LLT" && candidate.is_current !== "Y"
                                        ? "非当前 LLT 不可确认为正式编码"
                                        : candidate.reason
                                    }
                                  >
                                    <strong>
                                      {candidate.level} {candidate.code}
                                    </strong>{" "}
                                    {displayNameOf(candidate, mode)}
                                    {candidate.level === "LLT" && candidate.is_current === "N" ? " [非当前]" : ""}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {best && onOpenDetail && (
                          <button
                            className="mini"
                            type="button"
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

          <div className="coding-pagination">
            <span>
              第 {(clampedPage - 1) * pageSize + 1}–{Math.min(clampedPage * pageSize, visibleTerms.length)} 条 / 共{" "}
              {visibleTerms.length} 条
            </span>
            <div className="coding-pagination-controls">
              <label>
                每页{" "}
                <select
                  value={pageSize}
                  onChange={(event) => setPageSize(Number(event.target.value))}
                  aria-label="每页显示条数"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size} 条
                    </option>
                  ))}
                </select>
              </label>
              <button className="mini" type="button" disabled={clampedPage <= 1} onClick={() => setPage(1)}>
                首页
              </button>
              <button
                className="mini"
                type="button"
                disabled={clampedPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <span>
                {clampedPage} / {totalPages}
              </span>
              <button
                className="mini"
                type="button"
                disabled={clampedPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页
              </button>
              <button
                className="mini"
                type="button"
                disabled={clampedPage >= totalPages}
                onClick={() => setPage(totalPages)}
              >
                末页
              </button>
            </div>
          </div>
        </>
      )}

      {/* End-to-End Manual Recode Modal */}
      <dialog
        ref={recodeDialogRef}
        className="kz-dialog"
        aria-labelledby="recode-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeRecodeModal();
        }}
      >
        {recodeTarget && (
          <div className="kz-dialog-frame">
            <header className="kz-dialog-head">
              <h2 id="recode-dialog-title">人工改码核对 · MedDRA {effectiveVersion}</h2>
              <button className="icon-button" type="button" onClick={closeRecodeModal} aria-label="关闭改码窗口">
                <X size={16} />
              </button>
            </header>
            <div className="kz-dialog-body">
              <div className="recode-verbatim-card kz-thin">
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className={`type-badge type-${recodeTarget.coding_type}`}>{recodeTarget.coding_type}</span>
                  <strong>原文：{recodeTarget.term}</strong>
                  <span className="verbatim-sub">出现 {recodeTarget.count} 次</span>
                </div>
                {recodeTarget.occurrences?.[0] && (
                  <span className="verbatim-sub">
                    示例来源：{recodeTarget.occurrences[0].sheet} · {recodeTarget.occurrences[0].column} · 行{" "}
                    {String(recodeTarget.occurrences[0].excel_row ?? "-")}
                  </span>
                )}
              </div>

              <div className="recode-search-row">
                <input
                  value={recodeQuery}
                  onChange={(event) => setRecodeQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void searchInRecodeModal();
                    }
                  }}
                  placeholder="输入 PT/LLT 中英文或 8 位代码在当前绑定版本检索"
                  aria-label="改码检索"
                />
                {(["LLT", "PT"] as const).map((lvl) => {
                  const active = recodeLevels.includes(lvl);
                  return (
                    <button
                      key={lvl}
                      type="button"
                      className={active ? "mini primary" : "mini"}
                      onClick={() => {
                        const next: Array<"LLT" | "PT"> = active
                          ? recodeLevels.length > 1
                            ? recodeLevels.filter((x) => x !== lvl)
                            : [lvl]
                          : [...recodeLevels, lvl];
                        setRecodeLevels(next);
                        void searchInRecodeModal(recodeQuery, next);
                      }}
                    >
                      {lvl}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="kz-btn primary"
                  disabled={recodeSearching || !versionReady}
                  onClick={() => void searchInRecodeModal()}
                >
                  {recodeSearching ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                  检索校验
                </button>
              </div>

              {recodeError && (
                <div className="coding-banner error" role="alert">
                  <span className="coding-banner-text">{recodeError}</span>
                </div>
              )}

              <div className="recode-results" aria-label="词典检索候选">
                {recodeResults.map((hit) => {
                  const picked = recodePicked?.level === hit.level && recodePicked?.code === hit.code;
                  return (
                    <button
                      key={`${hit.level}:${hit.code}`}
                      type="button"
                      className={`recode-hit${picked ? " is-picked" : ""}`}
                      onClick={() => void verifyAndPickRecodeTerm(hit.level, hit.code)}
                    >
                      <span className={`level-badge level-${hit.level}`}>{hit.level}</span>
                      <strong>
                        {displayNameOf(hit, mode)}
                        {hit.level === "LLT" && hit.is_current === "N" && (
                          <>
                            {" "}
                            <span className="non-current-pill">非当前LLT</span>
                          </>
                        )}
                      </strong>
                      <em>{hit.code}</em>
                    </button>
                  );
                })}
                {!recodeResults.length && !recodeSearching && (
                  <div className="verbatim-sub" style={{ padding: "8px 4px" }}>
                    输入中英文症状、首选语或 8 位 MedDRA 代码并点击“检索校验”，点选条目后将自动校验父级 PT 一致性。
                  </div>
                )}
              </div>

              <div className="recode-pair-box kz-thin">
                <strong>已验证编码归属 {recodeVerifying ? "（正在校验 PT↔LLT 层级…）" : ""}</strong>
                {recodePicked ? (
                  <div className="recode-pair-grid">
                    <div>
                      <span className="verbatim-sub">PT（首选语）</span>
                      <div>
                        <strong>{recodePicked.pt_code}</strong>{" "}
                        {displayNameOf({ zh_name: recodePicked.pt_zh, en_name: recodePicked.pt_en }, mode)}
                      </div>
                    </div>
                    <div>
                      <span className="verbatim-sub">LLT（低位语 · 必须为当前术语）</span>
                      <div>
                        <strong>{recodePicked.code}</strong>{" "}
                        {displayNameOf({ zh_name: recodePicked.zh_name, en_name: recodePicked.en_name }, mode)}{" "}
                        <span className="type-badge type-AE">当前 LLT</span>
                      </div>
                      {recodePicked.pairedCurrentLlts && recodePicked.pairedCurrentLlts.length > 1 && (
                        <select
                          aria-label="切换该 PT 下的当前 LLT"
                          value={recodePicked.code}
                          style={{ marginTop: 4, width: "100%" }}
                          onChange={(event) => {
                            const chosen = recodePicked.pairedCurrentLlts?.find((c) => c.code === event.target.value);
                            if (!chosen) return;
                            setRecodePicked((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    code: chosen.code,
                                    en_name: chosen.en_name || chosen.display_name || "",
                                    zh_name: chosen.zh_name || "",
                                    is_current: "Y",
                                  }
                                : prev
                            );
                          }}
                        >
                          {recodePicked.pairedCurrentLlts.map((child) => (
                            <option key={child.code} value={child.code}>
                              {child.code} · {displayNameOf(child, mode)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {recodePicked.primary_soc && (
                      <div>
                        <span className="verbatim-sub">主 SOC</span>
                        <div>{recodePicked.primary_soc}</div>
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="verbatim-sub">请先在上方点选一条经过词典验证的 PT 或 LLT。</span>
                )}
              </div>

              <label className="recode-note-field">
                <span>改码原因 / 审阅备注</span>
                <input
                  value={recodeNote}
                  onChange={(event) => setRecodeNote(event.target.value)}
                  placeholder="例如：口语映射确认 / 选用当前LLT / 结合临床上下文改码"
                />
              </label>
            </div>
            <footer className="kz-dialog-foot">
              <button type="button" className="kz-btn" onClick={closeRecodeModal}>
                取消
              </button>
              <button
                type="button"
                className="kz-btn primary"
                disabled={
                  !recodePicked ||
                  !recodePicked.pt_code ||
                  !recodePicked.code ||
                  recodePicked.is_current !== "Y" ||
                  recodeVerifying
                }
                onClick={() => void saveManualRecode()}
              >
                <Check size={15} /> 保存改码决定
              </button>
            </footer>
          </div>
        )}
      </dialog>
    </section>
  );
}
