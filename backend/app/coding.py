from __future__ import annotations

import csv
import io
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable
from zipfile import BadZipFile, ZipFile

from .meddra_data import (
    LEVEL_LABELS,
    clinical_zh_expansions,
    fuzzy_candidate,
    fuzzy_score,
    fuzzy_threshold,
    normalize_text,
    token_key,
)


# Data listing columns that usually need MedDRA coding (label fragment → coding type).
# Priority 1: explicit field OIDs in parentheses (most reliable on EDC listings).
OID_CODING_MAP: dict[str, str] = {
    "AETERM": "AE",
    "MHTERM": "MH",
    "CMINDC": "CM",
    "AHDESC": "AH",
    "ALRTERM": "ALR",
    "DSDECOD": "DS",
}

# Priority 2: sheet-specific Chinese labels. Must appear as the primary label
# (not inside 是非问句 / 编号 / 备注).
CODING_COLUMN_HINTS: dict[str, tuple[str, ...]] = {
    "AE": ("不良事件名称", "不良事件描述"),
    "MH": ("疾病名称", "既往病史名称", "现病史名称"),
    "CM": ("用药原因", "适应症"),
    "AH": ("过敏史详述", "过敏描述"),
    "ALR": ("项目名称",),
    "DS": ("提前退出原因",),
}

# Headers that look similar but are never coding targets.
SKIP_HEADER_PATTERNS = (
    re.compile(r"^是否"),
    re.compile(r"编号$"),
    re.compile(r"^(项目编号|表单编号|受试者编号)$"),
    re.compile(r"(日期|时间|备注|说明|其他)"),
    re.compile(r"(剂量|频率|途径|严重|程度|转归|关系|措施|标准|状态)"),
)

# Header cells that identify the listing metadata columns.
META_HEADERS = {
    "项目编号",
    "表单编号",
    "受试者编号",
    "姓名缩写",
    "受试者状态",
    "试验中心编号",
    "试验中心名称",
    "数据节",
    "Instance顺序号",
    "数据块",
    "Block顺序号",
    "数据页",
    "最后修改时间",
    "行号",
}

# Keep only the minimum identifiers needed to locate a coding decision.
# Center names / subject status are omitted to reduce patient-context leakage.
SESSION_META_HEADERS = [
    "项目编号",
    "表单编号",
    "受试者编号",
    "行号",
]

MAX_LISTING_SHEETS = 40
MAX_WORKBOOK_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_ROWS_PER_SHEET = 200_000
MAX_UNIQUE_TERMS = 20_000
# Hard cap on retained occurrence rows across the whole import. Exceeding this
# fails closed — never keep count>len(occurrences) and silently drop export rows.
MAX_TOTAL_OCCURRENCES = 100_000
CONFIRMED_EXPORT_STATUSES = frozenset({"accepted", "edited", "manual", "confirmed"})
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "\n")


@dataclass
class CodingTarget:
    sheet: str
    column: str
    coding_type: str
    row_count: int
    non_empty_count: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "sheet": self.sheet,
            "column": self.column,
            "coding_type": self.coding_type,
            "row_count": self.row_count,
            "non_empty_count": self.non_empty_count,
        }


@dataclass
class UniqueTerm:
    term: str
    coding_type: str
    count: int
    occurrences: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "term": self.term,
            "coding_type": self.coding_type,
            "count": self.count,
            "occurrences": self.occurrences,
        }


def _header_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _match_coding_type(sheet: str, header: str) -> str | None:
    sheet_upper = (sheet or "").strip().upper()
    header = (header or "").strip()
    if not header or header in META_HEADERS:
        return None
    for pattern in SKIP_HEADER_PATTERNS:
        if pattern.search(header):
            return None

    # Strongest signal: EDC field OID in trailing parentheses.
    oid_match = re.search(r"\(([A-Za-z0-9_]+)\)\s*$", header)
    if oid_match:
        oid = oid_match.group(1).upper()
        if oid in OID_CODING_MAP:
            return OID_CODING_MAP[oid]

    # Sheet-scoped Chinese label (exact fragment at start or as the bare label).
    for coding_type, fragments in CODING_COLUMN_HINTS.items():
        if sheet_upper and (sheet_upper == coding_type or sheet_upper.startswith(coding_type)):
            for fragment in fragments:
                if header == fragment or header.startswith(fragment):
                    return coding_type
    return None


def _row_meta(row: dict[str, Any]) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    for key in SESSION_META_HEADERS:
        if key in row:
            value = row[key]
            meta[key] = "" if value is None else str(value)
    return meta


def _validate_headers(headers: list[str]) -> list[str]:
    cleaned = [_header_text(cell) for cell in headers]
    seen: set[str] = set()
    duplicates: list[str] = []
    for header in cleaned:
        if not header:
            continue
        if header in seen:
            duplicates.append(header)
        else:
            seen.add(header)
    if duplicates:
        uniq = "、".join(dict.fromkeys(duplicates))
        raise ValueError(f"存在重复表头，无法可靠定位来源列：{uniq}")
    return cleaned


def _parse_rows_from_matrix(
    headers: list[str],
    matrix: list[list[Any]],
    sheet: str,
    *,
    excel_rows: list[int] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, values in enumerate(matrix):
        excel_row = excel_rows[index] if excel_rows is not None else index + 2
        row: dict[str, Any] = {"_sheet": sheet, "_excel_row": excel_row}
        for col_index, header in enumerate(headers):
            if not header:
                continue
            row[header] = values[col_index] if col_index < len(values) else ""
        rows.append(row)
    return rows


def _decode_listing_text(content: bytes) -> str:
    last_error: Exception | None = None
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError as exc:
            last_error = exc
    raise ValueError(f"无法按 UTF-8/GB18030 解码 CSV：{last_error}")


def _append_occurrence(
    unique_map: dict[tuple[str, str], UniqueTerm],
    *,
    term: str,
    coding_type: str,
    occurrence: dict[str, Any],
    total_occurrences: list[int],
) -> None:
    if total_occurrences[0] >= MAX_TOTAL_OCCURRENCES:
        raise ValueError(
            f"编码出现次数超过上限 {MAX_TOTAL_OCCURRENCES}，已拒绝导入以避免静默丢行；请拆分 Listing 后重试"
        )
    key = (term, coding_type)
    if key not in unique_map:
        unique_map[key] = UniqueTerm(term=term, coding_type=coding_type, count=0)
    unique_map[key].count += 1
    unique_map[key].occurrences.append(occurrence)
    total_occurrences[0] += 1


def _detect_targets(sheet: str, headers: list[str]) -> list[tuple[str, str]]:
    targets: list[tuple[str, str]] = []
    for header in headers:
        coding_type = _match_coding_type(sheet, header)
        if coding_type:
            targets.append((header, coding_type))
    return targets


def csv_safe_cell(value: Any) -> str:
    text = "" if value is None else str(value)
    if text.startswith(_CSV_FORMULA_PREFIXES):
        return f"'{text}"
    return text


def _decision_for_term(decisions: dict[str, dict[str, Any]], coding_type: str, term: str) -> dict[str, Any]:
    return decisions.get(f"{coding_type}|{term}") or {}


def _codes_from_decision(decision: dict[str, Any]) -> dict[str, str]:
    pt = decision.get("pt") or {}
    llt = decision.get("llt") or {}
    pt_code = str(decision.get("pt_code") or pt.get("code") or "")
    llt_code = str(decision.get("llt_code") or llt.get("code") or "")
    pt_zh = str(decision.get("pt_zh") or pt.get("zh_name") or "")
    pt_en = str(decision.get("pt_en") or pt.get("en_name") or "")
    llt_zh = str(decision.get("llt_zh") or llt.get("zh_name") or "")
    llt_en = str(decision.get("llt_en") or llt.get("en_name") or "")
    if llt_code and not pt_code:
        pt_code = str(decision.get("pt_from_llt_code") or "")
        pt_zh = str(decision.get("pt_from_llt_zh") or "")
        pt_en = str(decision.get("pt_from_llt_en") or "")
    return {
        "pt_code": pt_code,
        "pt_zh": pt_zh,
        "pt_en": pt_en,
        "llt_code": llt_code,
        "llt_zh": llt_zh,
        "llt_en": llt_en,
    }


TermLookup = Callable[[str, str], dict[str, Any] | None]


def validate_coding_pair(lookup: TermLookup, decision: dict[str, Any]) -> dict[str, Any]:
    """Resolve both confirmed codes and canonical names from one ready index."""
    codes = _codes_from_decision(decision)
    pt_code, llt_code = codes["pt_code"], codes["llt_code"]
    if not pt_code or not llt_code:
        return {"ok": False, "reason": "正式编码必须包含当前 LLT 和对应父级 PT"}
    llt = lookup("LLT", llt_code)
    if llt is None:
        return {"ok": False, "reason": f"LLT {llt_code} 不在当前词典索引中"}
    if llt.get("is_current") != "Y":
        return {"ok": False, "reason": f"LLT {llt_code} 为非当前术语"}
    if llt.get("parent_code") != pt_code:
        return {"ok": False, "reason": f"LLT {llt_code} 的父级 PT 应为 {llt.get('parent_code') or '空'}"}
    pt = lookup("PT", pt_code)
    if pt is None:
        return {"ok": False, "reason": f"PT {pt_code} 不在当前词典索引中"}
    return {
        "ok": True,
        "codes": {
            "pt_code": pt_code,
            "pt_zh": pt.get("zh_name") or "",
            "pt_en": pt.get("en_name") or "",
            "llt_code": llt_code,
            "llt_zh": llt.get("zh_name") or "",
            "llt_en": llt.get("en_name") or "",
        },
    }


def _append_occurrence_rows(
    rows: list[dict[str, Any]],
    *,
    item: dict[str, Any],
    status: str,
    note: str,
    codes: dict[str, str],
    match_type: str = "",
    match_score: Any = "",
    exception_reason: str = "",
    dictionary_version: str = "",
    source_signature: str = "",
) -> None:
    term = item.get("term") or ""
    coding_type = item.get("coding_type") or ""
    occurrences = list(item.get("occurrences") or [{}])
    # Fail closed if upstream truncated occurrences while inflating count.
    count = int(item.get("count") or len(occurrences) or 0)
    if count != len(occurrences):
        raise ValueError(
            f"术语「{term}」出现次数 count={count} 与 occurrences={len(occurrences)} 不一致，拒绝部分导出"
        )
    for occ in occurrences:
        row = {
            "术语类型": coding_type,
            "原文术语": term,
            "编码状态": status,
            "匹配方式": match_type,
            "匹配分": match_score,
            "PT代码": codes.get("pt_code", ""),
            "PT中文": codes.get("pt_zh", ""),
            "PT英文": codes.get("pt_en", ""),
            "LLT代码": codes.get("llt_code", ""),
            "LLT中文": codes.get("llt_zh", ""),
            "LLT英文": codes.get("llt_en", ""),
            "备注": note,
        }
        if dictionary_version:
            row["词典版本"] = dictionary_version
        if source_signature:
            row["索引签名"] = source_signature
        if exception_reason:
            row["审阅异常原因"] = exception_reason
        for meta in SESSION_META_HEADERS:
            if meta in occ:
                row[meta] = occ.get(meta) or ""
        if "sheet" in occ:
            row["来源Sheet"] = occ.get("sheet") or ""
        if "column" in occ:
            row["来源列"] = occ.get("column") or ""
        if "excel_row" in occ:
            row["来源行"] = occ.get("excel_row") or ""
        rows.append(row)


def parse_data_listing_excel(content: bytes, filename: str = "") -> dict[str, Any]:
    """Parse a multi-sheet data listing workbook (or CSV) into coding targets + unique terms."""
    from openpyxl import load_workbook
    from openpyxl.utils.exceptions import InvalidFileException

    if filename.lower().endswith(".csv") or (b"\x00" not in content[:200] and b"," in content[:200] and b"PK" not in content[:4]):
        return parse_data_listing_csv(content, filename or "listing.csv")

    content_stream = io.BytesIO(content)
    try:
        with ZipFile(content_stream) as archive:
            if sum(member.file_size for member in archive.infolist()) > MAX_WORKBOOK_EXPANDED_BYTES:
                raise ValueError("工作簿解包后超过 512 MB，请拆分后导入")
        workbook = load_workbook(content_stream, read_only=True, data_only=True)
    except (BadZipFile, InvalidFileException, KeyError) as exc:
        raise ValueError("不是有效的 Excel 工作簿，请检查文件格式或重新导出") from exc
    try:
        sheets_info: list[dict[str, Any]] = []
        targets: list[CodingTarget] = []
        unique_map: dict[tuple[str, str], UniqueTerm] = {}
        total_rows = 0
        total_occurrences = [0]

        sheet_seen = 0
        for sheet_name in workbook.sheetnames:
            if sheet_name.upper() == "TOC":
                continue
            sheet_seen += 1
            if sheet_seen > MAX_LISTING_SHEETS:
                raise ValueError(f"工作表过多，最多支持 {MAX_LISTING_SHEETS} 个数据表")
            ws = workbook[sheet_name]
            rows_iter = ws.iter_rows(values_only=True)
            try:
                header_row = next(rows_iter)
            except StopIteration:
                continue
            headers = _validate_headers(list(header_row))
            if not any(headers):
                continue

            sheet_rows: list[list[Any]] = []
            excel_rows: list[int] = []
            for excel_row, values in enumerate(rows_iter, start=2):
                if values is None:
                    continue
                # Skip fully empty rows but keep the true Excel row number for
                # non-empty rows so EDC source tracing stays accurate.
                if all(cell is None or str(cell).strip() == "" for cell in values):
                    continue
                sheet_rows.append(list(values))
                excel_rows.append(excel_row)
                if len(sheet_rows) > MAX_ROWS_PER_SHEET:
                    raise ValueError(f"工作表 {sheet_name} 行数超过上限 {MAX_ROWS_PER_SHEET}")
            total_rows += len(sheet_rows)
            rows = _parse_rows_from_matrix(headers, sheet_rows, sheet_name, excel_rows=excel_rows)
            sheet_targets = _detect_targets(sheet_name, headers)
            sheets_info.append(
                {
                    "sheet": sheet_name,
                    "headers": headers,
                    "row_count": len(rows),
                    "coding_columns": [{"column": col, "coding_type": ctype} for col, ctype in sheet_targets],
                }
            )

            for column, coding_type in sheet_targets:
                non_empty = 0
                for row in rows:
                    value = row.get(column)
                    if value is None:
                        continue
                    term = str(value).strip()
                    if not term:
                        continue
                    non_empty += 1
                    _append_occurrence(
                        unique_map,
                        term=term,
                        coding_type=coding_type,
                        occurrence={
                            "sheet": sheet_name,
                            "column": column,
                            **_row_meta(row),
                            "excel_row": row.get("_excel_row"),
                        },
                        total_occurrences=total_occurrences,
                    )
                targets.append(
                    CodingTarget(
                        sheet=sheet_name,
                        column=column,
                        coding_type=coding_type,
                        row_count=len(rows),
                        non_empty_count=non_empty,
                    )
                )

        unique_terms = sorted(
            unique_map.values(),
            key=lambda item: (-item.count, item.coding_type, item.term),
        )
        if len(unique_terms) > MAX_UNIQUE_TERMS:
            raise ValueError(f"唯一术语过多，最多支持 {MAX_UNIQUE_TERMS} 个")
        return {
            "filename": filename,
            "sheets": sheets_info,
            "coding_targets": [t.as_dict() for t in targets],
            "unique_terms": [t.as_dict() for t in unique_terms],
            "stats": {
                "sheet_count": len(sheets_info),
                "data_rows": total_rows,
                "target_count": len(targets),
                "unique_term_count": len(unique_terms),
                "occurrence_count": total_occurrences[0],
            },
        }
    finally:
        workbook.close()


def parse_data_listing_csv(content: bytes, filename: str = "listing.csv") -> dict[str, Any]:
    text = _decode_listing_text(content)
    reader = csv.reader(io.StringIO(text))
    matrix = [list(row) for row in reader]
    if not matrix:
        return {
            "filename": filename,
            "sheets": [],
            "coding_targets": [],
            "unique_terms": [],
            "stats": {
                "sheet_count": 0,
                "data_rows": 0,
                "target_count": 0,
                "unique_term_count": 0,
                "occurrence_count": 0,
            },
        }
    headers = _validate_headers(matrix[0])
    body: list[list[Any]] = []
    excel_rows: list[int] = []
    for excel_row, row in enumerate(matrix[1:], start=2):
        if not any(str(c).strip() for c in row):
            continue
        body.append(list(row))
        excel_rows.append(excel_row)
    if len(body) > MAX_ROWS_PER_SHEET:
        raise ValueError(f"CSV 行数超过上限 {MAX_ROWS_PER_SHEET}")
    # Treat CSV as a single sheet named after the file stem.
    sheet_name = Path(filename).stem[:32] or "CSV"
    rows = _parse_rows_from_matrix(headers, body, sheet_name, excel_rows=excel_rows)
    targets: list[CodingTarget] = []
    unique_map: dict[tuple[str, str], UniqueTerm] = {}
    sheet_targets = _detect_targets(sheet_name, headers)

    # If no sheet-based match, try header-only detection.
    if not sheet_targets:
        sheet_targets = _detect_targets("", headers)

    total_occurrences = [0]
    for column, coding_type in sheet_targets:
        non_empty = 0
        for row in rows:
            value = row.get(column)
            if value is None:
                continue
            term = str(value).strip()
            if not term:
                continue
            non_empty += 1
            _append_occurrence(
                unique_map,
                term=term,
                coding_type=coding_type,
                occurrence={
                    "sheet": sheet_name,
                    "column": column,
                    **_row_meta(row),
                    "excel_row": row.get("_excel_row"),
                },
                total_occurrences=total_occurrences,
            )
        targets.append(
            CodingTarget(
                sheet=sheet_name,
                column=column,
                coding_type=coding_type,
                row_count=len(rows),
                non_empty_count=non_empty,
            )
        )

    unique_terms = sorted(unique_map.values(), key=lambda item: (-item.count, item.coding_type, item.term))
    if len(unique_terms) > MAX_UNIQUE_TERMS:
        raise ValueError(f"唯一术语过多，最多支持 {MAX_UNIQUE_TERMS} 个")
    return {
        "filename": filename,
        "sheets": [
            {
                "sheet": sheet_name,
                "headers": headers,
                "row_count": len(rows),
                "coding_columns": [{"column": col, "coding_type": ctype} for col, ctype in sheet_targets],
            }
        ],
        "coding_targets": [t.as_dict() for t in targets],
        "unique_terms": [t.as_dict() for t in unique_terms],
        "stats": {
            "sheet_count": 1,
            "data_rows": len(rows),
            "target_count": len(targets),
            "unique_term_count": len(unique_terms),
            "occurrence_count": total_occurrences[0],
        },
    }


def _suggestion_payload(
    term: dict[str, Any],
    match_type: str,
    score: float,
    reason: str,
) -> dict[str, Any]:
    level = term.get("level") or "PT"
    return {
        "level": level,
        "level_label": LEVEL_LABELS.get(level, level),
        "code": term.get("code"),
        "en_name": term.get("en_name") or "",
        "zh_name": term.get("zh_name") or "",
        "is_current": term.get("is_current") or "",
        "match_type": match_type,
        "score": round(float(score), 1),
        "reason": reason,
        "parent_code": term.get("parent_code"),
    }


class TermSuggester:
    """Batch PT/LLT suggestion engine for verbatim coding."""

    def __init__(self, store: Any):
        self._store = store
        self._terms: tuple[dict[str, Any], ...] | None = None
        self._by_level: dict[str, list[dict[str, Any]]] | None = None
        self._pt_by_code: dict[str, dict[str, Any]] | None = None
        self._norm_index: dict[tuple[str, str], list[dict[str, Any]]] | None = None
        self._exact_case_index: dict[tuple[str, str], list[dict[str, Any]]] | None = None
        self._token_index: dict[tuple[str, str], list[dict[str, Any]]] | None = None
        self._name_rows: list[tuple[dict[str, Any], str, str, str]] | None = None
        self._prefix_buckets: dict[tuple[str, str], list[tuple[dict[str, Any], str, str]]] | None = None

    def _ensure_index(self) -> None:
        if self._terms is not None:
            return
        terms = tuple(
            term
            for term in self._store.all_terms()
            if term.get("level") in {"PT", "LLT"}
        )
        by_level: dict[str, list[dict[str, Any]]] = {"PT": [], "LLT": []}
        pt_by_code: dict[str, dict[str, Any]] = {}
        norm_index: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        exact_case_index: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        token_index: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        name_rows: list[tuple[dict[str, Any], str, str, str]] = []
        prefix_buckets: dict[tuple[str, str], list[tuple[dict[str, Any], str, str]]] = defaultdict(list)
        for term in terms:
            level = term.get("level") or ""
            if level in by_level:
                by_level[level].append(term)
            if level == "PT":
                pt_by_code[str(term.get("code") or "")] = term
            for lang, name in (("zh", term.get("zh_name")), ("en", term.get("en_name"))):
                if not name:
                    continue
                raw = str(name)
                norm = normalize_text(raw)
                key = (lang, norm)
                if term not in norm_index[key]:
                    norm_index[key].append(term)
                exact_key = (lang, raw)
                if term not in exact_case_index[exact_key]:
                    exact_case_index[exact_key].append(term)
                tkey = token_key(raw)
                if tkey and term not in token_index[(lang, tkey)]:
                    token_index[(lang, tkey)].append(term)
                name_rows.append((term, lang, norm, raw))
                if norm:
                    prefix_buckets[(lang, norm[0])].append((term, norm, raw))
        self._terms = terms
        self._by_level = by_level
        self._pt_by_code = pt_by_code
        self._norm_index = dict(norm_index)
        self._exact_case_index = dict(exact_case_index)
        self._token_index = dict(token_index)
        self._name_rows = name_rows
        self._prefix_buckets = dict(prefix_buckets)

    def suggest_batch(
        self,
        terms: Iterable[str],
        *,
        mode: str = "both",
        limit_per_term: int = 5,
    ) -> dict[str, dict[str, Any]]:
        self._ensure_index()
        assert self._terms is not None
        assert self._norm_index is not None
        langs = ["zh", "en"] if mode == "both" else [mode]
        limit_per_term = max(1, min(int(limit_per_term), 20))
        results: dict[str, dict[str, Any]] = {}

        for raw_term in terms:
            query = (raw_term or "").strip()
            if not query:
                continue
            results[query] = self._suggest_one(query, langs, limit_per_term)
        return results

    def _suggest_one(self, query: str, langs: list[str], limit_per_term: int) -> dict[str, Any]:
        assert self._norm_index is not None
        assert self._exact_case_index is not None
        assert self._token_index is not None
        assert self._name_rows is not None
        assert self._pt_by_code is not None

        norm_query = normalize_text(query)
        exact_hits: list[dict[str, Any]] = []
        seen: set[str] = set()

        def key_of(term: dict[str, Any]) -> str:
            return f"{term.get('level')}:{term.get('code')}"

        def push(term: dict[str, Any], match_type: str, score: float, reason: str) -> None:
            key = key_of(term)
            if key in seen:
                return
            seen.add(key)
            payload = _suggestion_payload(term, match_type, score, reason)
            if payload.get("level") == "LLT" and payload.get("parent_code"):
                parent = self._pt_by_code.get(str(payload["parent_code"]))
                if parent is not None:
                    payload["pt"] = _suggestion_payload(parent, "parent", 100, "LLT 对应 PT")
            exact_hits.append(payload)

        # Preserve distinct codes that only differ by English casing (e.g. Rh vs rh).
        for lang in langs:
            for term in self._exact_case_index.get((lang, query), []):
                if term.get("level") == "LLT" and term.get("is_current") != "Y":
                    score, reason = 96, "LLT 完全匹配（大小写精确；非当前术语，建议复核）"
                elif term.get("level") == "LLT":
                    score, reason = 100, "LLT 完全匹配（大小写精确）"
                else:
                    score, reason = 99, "PT 完全匹配（大小写精确）"
                push(term, "exact", score, reason)
            for term in self._norm_index.get((lang, norm_query), []):
                if term.get("level") == "LLT" and term.get("is_current") != "Y":
                    score, reason = 96, "LLT 完全匹配（非当前术语，建议复核）"
                elif term.get("level") == "LLT":
                    score, reason = 100, "LLT 完全匹配"
                else:
                    score, reason = 99, "PT 完全匹配"
                push(term, "exact", score, reason)

        if not exact_hits:
            query_key = token_key(query)
            if query_key:
                for lang in langs:
                    for term in self._token_index.get((lang, query_key), []):
                        push(term, "lexical", 94, "词元集合一致（词序变体）")

        if not exact_hits:
            for rewritten, reason in clinical_zh_expansions(query):
                rewritten_norm = normalize_text(rewritten)
                if not rewritten_norm or rewritten_norm == norm_query:
                    continue
                for lang in langs:
                    for term in self._norm_index.get((lang, rewritten_norm), []):
                        push(term, "alias", 92, reason)

        assert self._prefix_buckets is not None
        assert self._name_rows is not None

        if not exact_hits and len(norm_query) >= 2:
            # Cheap full-table containment (string `in`) preserves mid-string hits.
            # Length gates avoid comparing clearly incompatible names.
            qlen = len(norm_query)
            contains_hits: list[tuple[float, dict[str, Any], str, str]] = []
            for term, lang, norm_name, _raw in self._name_rows:
                if lang not in langs or not norm_name or norm_name == norm_query:
                    continue
                nlen = len(norm_name)
                if nlen >= qlen and (nlen - qlen) <= max(24, qlen) and norm_query in norm_name:
                    score = 84 - min(20, (nlen - qlen) * 0.3)
                    contains_hits.append((score, term, "contains", "术语文本包含原文"))
                elif 2 <= nlen <= qlen and (qlen - nlen) <= max(24, qlen) and norm_name in norm_query:
                    score = 80 - min(15, (qlen - nlen) * 0.3)
                    contains_hits.append((score, term, "contains", "原文包含术语文本"))
            contains_hits.sort(
                key=lambda item: (
                    -item[0],
                    0 if item[1].get("level") == "LLT" else 1,
                    abs(len(str(item[1].get("en_name") or item[1].get("zh_name") or "")) - len(norm_query)),
                )
            )
            for score, term, match_type, reason in contains_hits[:limit_per_term]:
                push(term, match_type, score, reason)

        if not exact_hits and len(norm_query) >= 3:
            # Fuzzy is expensive; restrict to same first-character buckets.
            fuzzy_rows: list[tuple[dict[str, Any], str, str]] = []
            for lang in langs:
                fuzzy_rows.extend(self._prefix_buckets.get((lang, norm_query[0]), []))
            fuzzy_hits: list[tuple[float, dict[str, Any], str, str]] = []
            threshold = fuzzy_threshold(norm_query)
            for term, norm_name, _raw in fuzzy_rows:
                if not norm_name:
                    continue
                if abs(len(norm_name) - len(norm_query)) > max(4, len(norm_query) // 2 + 2):
                    continue
                if not fuzzy_candidate(norm_query, norm_name):
                    continue
                score = fuzzy_score(norm_query, norm_name)
                if score >= threshold:
                    fuzzy_hits.append((score, term, "fuzzy", "拼写或近似文本候选"))
            fuzzy_hits.sort(key=lambda item: (-item[0], 0 if item[1].get("level") == "LLT" else 1))
            for score, term, match_type, reason in fuzzy_hits[:limit_per_term]:
                push(term, match_type, score, reason)

        exact_hits.sort(
            key=lambda item: (
                -float(item.get("score") or 0),
                0 if item.get("level") == "LLT" else 1,
                0 if item.get("match_type") == "exact" and "大小写精确" in str(item.get("reason") or "") else 1,
                str(item.get("code") or ""),
            )
        )
        best = exact_hits[0] if exact_hits else None
        pt_payload: dict[str, Any] | None = None
        if best and best.get("level") == "LLT" and best.get("parent_code"):
            pt_term = self._pt_by_code.get(str(best["parent_code"]))
            if pt_term is not None:
                pt_payload = _suggestion_payload(pt_term, "parent", 100, "LLT 对应 PT")
        elif best and best.get("level") == "PT":
            pt_payload = best

        candidates = exact_hits[:limit_per_term]
        return {
            "query": query,
            "best": best,
            "pt": pt_payload,
            "candidates": candidates,
            "status": "suggested" if best else "no_match",
        }

    def _find_term(self, level: str, code: str) -> dict[str, Any] | None:
        if level == "PT" and self._pt_by_code is not None:
            return self._pt_by_code.get(str(code))
        assert self._by_level is not None
        for term in self._by_level.get(level, []):
            if str(term.get("code")) == str(code):
                return term
        return None


def build_export_bundle(
    unique_terms: list[dict[str, Any]],
    decisions: dict[str, dict[str, Any]],
    *,
    dictionary_version: str = "",
    lookup: TermLookup | None = None,
    source_signature: str = "",
) -> dict[str, Any]:
    """Split confirmed coded rows from review exceptions without promoting candidates."""
    coded_rows: list[dict[str, Any]] = []
    exception_rows: list[dict[str, Any]] = []
    for item in unique_terms:
        term = item.get("term") or ""
        coding_type = item.get("coding_type") or ""
        decision = _decision_for_term(decisions, coding_type, term)
        status = str(decision.get("status") or "pending").strip().lower() or "pending"
        note = str(decision.get("note") or "")
        codes = _codes_from_decision(decision)
        if status in CONFIRMED_EXPORT_STATUSES and lookup is not None:
            checked = validate_coding_pair(lookup, decision)
            if not checked["ok"]:
                raise ValueError(f"术语「{term}」校验失败：{checked['reason']}")
            codes = checked["codes"]
        if status in CONFIRMED_EXPORT_STATUSES and codes["pt_code"] and codes["llt_code"]:
            _append_occurrence_rows(
                coded_rows,
                item=item,
                status=status,
                note=note,
                codes=codes,
                match_type=str(decision.get("match_type") or ""),
                match_score=decision.get("score") or "",
                dictionary_version=dictionary_version,
                source_signature=source_signature,
            )
            continue
        if status in CONFIRMED_EXPORT_STATUSES:
            reason = "已确认但缺少 PT/LLT 代码"
        elif status in {"rejected", "reject"}:
            reason = "已拒绝，不得写入正式编码结果"
        elif status == "pending" or not decision:
            reason = "尚未人工确认"
        else:
            reason = f"状态 {status} 不可导出为正式编码"
        # Never copy suggestion/best codes into exception rows either.
        _append_occurrence_rows(
            exception_rows,
            item=item,
            status=status,
            note=note,
            codes={"pt_code": "", "pt_zh": "", "pt_en": "", "llt_code": "", "llt_zh": "", "llt_en": ""},
            exception_reason=reason,
            dictionary_version=dictionary_version,
            source_signature=source_signature,
        )
    return {
        "coded_rows": coded_rows,
        "exception_rows": exception_rows,
        "stats": {
            "unique_term_count": len(unique_terms),
            "coded_row_count": len(coded_rows),
            "exception_row_count": len(exception_rows),
            "confirmed_term_count": len({(r.get("术语类型"), r.get("原文术语")) for r in coded_rows}),
            "exception_term_count": len({(r.get("术语类型"), r.get("原文术语")) for r in exception_rows}),
        },
    }


def build_export_rows(
    unique_terms: list[dict[str, Any]],
    decisions: dict[str, dict[str, Any]],
    *,
    dictionary_version: str = "",
) -> list[dict[str, Any]]:
    """Backward-compatible helper: formal coded rows only."""
    return build_export_bundle(unique_terms, decisions, dictionary_version=dictionary_version)["coded_rows"]

def code_to_csv(rows: list[dict[str, Any]], *, include_coding: bool = True) -> str:
    if not rows:
        return ""
    # Stable column order: coding columns first, then metadata.
    preferred = [
        "术语类型",
        "原文术语",
        "编码状态",
        "词典版本",
        "索引签名",
        "PT代码",
        "PT中文",
        "PT英文",
        "LLT代码",
        "LLT中文",
        "LLT英文",
        "匹配方式",
        "匹配分",
        "备注",
        "审阅异常原因",
    ]
    keys = dict.fromkeys(key for row in rows for key in row)
    fieldnames = [key for key in preferred if key in keys] + [key for key in keys if key not in preferred]
    if not include_coding:
        codes = {"PT代码", "PT中文", "PT英文", "LLT代码", "LLT中文", "LLT英文", "匹配方式", "匹配分"}
        fieldnames = [key for key in fieldnames if key not in codes]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: csv_safe_cell(row.get(key, "")) for key in fieldnames})
    return output.getvalue()


def safe_download_filename(name: str, default: str = "meddra_coded_listing.csv") -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n]+', "", Path(name or "").name).strip()
    if not cleaned:
        return default
    if not cleaned.lower().endswith(".csv"):
        cleaned = f"{cleaned}.csv"
    return cleaned[:120]


def content_disposition_attachment(name: str, default: str = "meddra_export.csv") -> str:
    """RFC 5987 Content-Disposition that never puts non-ASCII into filename=."""
    from urllib.parse import quote

    cleaned = safe_download_filename(name, default)
    ascii_fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", cleaned).strip("._") or default
    if not ascii_fallback.lower().endswith(".csv"):
        ascii_fallback = f"{ascii_fallback}.csv"
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(cleaned)}"
