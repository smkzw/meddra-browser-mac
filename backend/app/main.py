from __future__ import annotations

import base64
from functools import lru_cache, partial
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .coding import (
    MAX_UNIQUE_TERMS,
    TermSuggester,
    build_export_bundle,
    code_to_csv,
    content_disposition_attachment,
    parse_data_listing_csv,
    parse_data_listing_excel,
    validate_coding_pair,
)
from .meddra_data import (
    ALL_SEARCH_LEVELS,
    MeddraIndexer,
    MeddraStore,
    SourceConfig,
    add_source_root,
    default_source_config,
    discover_releases,
    source_roots_status,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = (PROJECT_ROOT / "frontend" / "dist").resolve()
ALLOWED_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]", "testserver"})
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}

app = FastAPI(title="MedDRA Browser", version="0.2.0")
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


def _request_hostname(host_header: str) -> str:
    host = (host_header or "").strip().lower()
    if host.startswith("[") and "]" in host:
        return host[1 : host.index("]")]
    return host.split(":", 1)[0]


def _host_allowed(host_header: str) -> bool:
    hostname = _request_hostname(host_header)
    return hostname in ALLOWED_LOOPBACK_HOSTS or hostname.endswith(".localhost")


def _origin_parts(origin: str) -> tuple[str, str, int | None] | None:
    if not origin or origin == "null":
        return None
    try:
        parsed = urlparse(origin)
        scheme, hostname, port = parsed.scheme, parsed.hostname, parsed.port
    except ValueError:
        return None
    if scheme not in {"http", "https"} or not hostname:
        return None
    return scheme, hostname.lower(), port


def _is_runtime_info_path(path: str) -> bool:
    return path.rstrip("/") == "/api/runtime-info"


def _same_authority(request: Request, origin: str) -> bool:
    parts = _origin_parts(origin)
    if parts is None:
        return False
    scheme, hostname, port = parts
    if scheme != request.url.scheme or hostname != request.url.hostname:
        return False
    default_port = 443 if scheme == "https" else 80
    try:
        host_port = request.url.port
    except ValueError:
        return False
    return (port if port is not None else default_port) == (host_port if host_port is not None else default_port)


def _origin_permitted(request: Request) -> bool:
    origin = request.headers.get("origin")
    site = (request.headers.get("sec-fetch-site") or "").lower()
    runtime_probe = _is_runtime_info_path(request.url.path) and request.method in {"GET", "HEAD", "OPTIONS"}
    referer = request.headers.get("referer")
    if referer:
        if referer == "null" or referer.startswith("file:"):
            if not runtime_probe:
                return False
        elif not _same_authority(request, referer):
            return False
    if origin == "null":
        # file:// portable discovery may probe runtime-info only.
        return runtime_probe
    if site in {"cross-site", "same-site"} and not runtime_probe:
        return False
    return origin is None or _same_authority(request, origin)


def _runtime_info_cors_headers(request: Request) -> dict[str, str]:
    headers = {
        "Access-Control-Allow-Origin": "null",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") or "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Cache-Control": "no-store",
        "Vary": "Origin",
    }
    return headers


def _with_security_headers(response: Response) -> Response:
    for key, value in SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


@app.middleware("http")
async def local_access_guard(request: Request, call_next):  # type: ignore[no-untyped-def]
    if not _host_allowed(request.headers.get("host", "")):
        return _with_security_headers(
            JSONResponse(status_code=403, content={"error": "host_not_allowed", "detail": "仅允许本机回环访问"})
        )
    if request.url.path.startswith("/api/") and not _origin_permitted(request):
        return _with_security_headers(
            JSONResponse(status_code=403, content={"error": "origin_not_allowed", "detail": "禁止跨站访问本地 API"})
        )

    if request.method == "OPTIONS":
        if _is_runtime_info_path(request.url.path) and request.headers.get("origin") == "null":
            return _with_security_headers(Response(status_code=204, headers=_runtime_info_cors_headers(request)))
        return _with_security_headers(Response(status_code=403))

    response = await call_next(request)
    if _is_runtime_info_path(request.url.path) and request.headers.get("origin") == "null":
        for key, value in _runtime_info_cors_headers(request).items():
            response.headers[key] = value
    return _with_security_headers(response)


INDEX_LOCK = threading.Lock()
INDEX_JOBS: dict[str, dict[str, Any]] = {}


@app.exception_handler(RuntimeError)
async def runtime_error_handler(request: Request, exc: RuntimeError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"error": "meddra_data_unavailable", "detail": str(exc)},
    )


@app.exception_handler(sqlite3.DatabaseError)
async def sqlite_error_handler(request: Request, exc: sqlite3.DatabaseError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": "meddra_index_unavailable",
            "detail": "本地词典索引正在准备或需要重建，请等待进度条完成后再操作",
        },
    )


class SearchRequest(BaseModel):
    query: str
    version: Optional[str] = None
    mode: str = "both"
    levels: list[str] = ["PT"]
    soc_codes: list[str] = []
    include_synonyms: bool = True
    ignore_diacritics: bool = True
    include_non_current: bool = True
    limit_per_group: int = Field(default=60, ge=1, le=500)
    offset_per_group: int = Field(default=0, ge=0)


class AdvancedCondition(BaseModel):
    value: str = ""
    operator: str = "contains"


class AdvancedSearchRequest(BaseModel):
    version: Optional[str] = None
    mode: str = "both"
    levels: list[str] = ["PT"]
    boolean: str = "AND"
    conditions: list[AdvancedCondition]
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=200, ge=1, le=500)


class ExportRequest(BaseModel):
    rows: list[dict[str, Any]]
    filename: str = "meddra_export.csv"


class SourceRootRequest(BaseModel):
    path: str


class CodingImportRequest(BaseModel):
    filename: str = "listing.xlsx"
    content_base64: str


class CodingSuggestRequest(BaseModel):
    terms: list[str]
    version: Optional[str] = None
    mode: str = "both"
    limit_per_term: int = Field(default=5, ge=1, le=20)


class CodingExportRequest(BaseModel):
    unique_terms: list[dict[str, Any]] = Field(max_length=MAX_UNIQUE_TERMS)
    decisions: dict[str, dict[str, Any]] = Field(default_factory=dict)
    filename: str = "meddra_coded_listing.csv"
    # coded = formal confirmed rows only; exceptions = review exception list;
    # both = coded rows followed by an exception section.
    export_mode: str = Field(default="coded")
    dictionary_version: Optional[str] = None
    source_signature: Optional[str] = None


class CodingValidateRequest(BaseModel):
    decisions: dict[str, dict[str, Any]] = Field(default_factory=dict)
    version: Optional[str] = None
    source_signature: Optional[str] = None


def index_job_key(config: Any) -> str:
    return str(config.db_path.resolve())


def public_index_status(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": job.get("version"),
        "state": job.get("state", "pending"),
        "phase": job.get("phase", "pending"),
        "message": job.get("message", ""),
        "percent": int(job.get("percent", 0)),
        "processed_rows": int(job.get("processed_rows", 0)),
        "total_rows": int(job.get("total_rows", 0)),
        "started_at": job.get("started_at"),
        "updated_at": job.get("updated_at"),
        "error": job.get("error", ""),
    }


def ready_index_status(config: Any) -> dict[str, Any]:
    now = time.time()
    return {
        "version": config.version,
        "state": "ready",
        "phase": "ready",
        "message": "索引已可用",
        "percent": 100,
        "processed_rows": 0,
        "total_rows": 0,
        "started_at": now,
        "updated_at": now,
        "error": "",
    }


def pending_index_status(config: Any) -> dict[str, Any]:
    now = time.time()
    return {
        "version": config.version,
        "state": "pending",
        "phase": "pending",
        "message": "索引尚未建立",
        "percent": 0,
        "processed_rows": 0,
        "total_rows": 0,
        "started_at": now,
        "updated_at": now,
        "error": "",
    }


def index_status_for_config(config: Any, *, start: bool = False, force: bool = False) -> dict[str, Any]:
    indexer = MeddraIndexer(config)
    key = index_job_key(config)
    with INDEX_LOCK:
        current = INDEX_JOBS.get(key)
        if current and current.get("state") == "running":
            return public_index_status(current)

    if not force and indexer.is_current():
        with INDEX_LOCK:
            current = INDEX_JOBS.get(key)
            if current and current.get("state") == "running":
                return public_index_status(current)
            if current and current.get("state") == "ready":
                return public_index_status(current)
            status = ready_index_status(config)
            INDEX_JOBS[key] = status
            return status

    with INDEX_LOCK:
        current = INDEX_JOBS.get(key)
        if current and current.get("state") == "running":
            return public_index_status(current)
        if not start:
            if current and current.get("state") == "error":
                return public_index_status(current)
            return pending_index_status(config)
        now = time.time()
        job = {
            "version": config.version,
            "state": "running",
            "phase": "preparing",
            "message": "准备创建本地索引",
            "percent": 0,
            "processed_rows": 0,
            "total_rows": 0,
            "started_at": now,
            "updated_at": now,
            "error": "",
        }
        INDEX_JOBS[key] = job

    def update_progress(event: dict[str, Any]) -> None:
        with INDEX_LOCK:
            current_job = INDEX_JOBS.get(key)
            if not current_job:
                return
            current_job.update(
                {
                    "phase": event.get("phase", current_job.get("phase")),
                    "message": event.get("message", current_job.get("message")),
                    "percent": min(99, int(event.get("percent", current_job.get("percent", 0)))),
                    "processed_rows": int(event.get("processed_rows", current_job.get("processed_rows", 0))),
                    "total_rows": int(event.get("total_rows", current_job.get("total_rows", 0))),
                    "updated_at": time.time(),
                }
            )

    def run_index() -> None:
        try:
            MeddraIndexer(config, progress_callback=update_progress).ensure_index(force=force)
        except Exception as exc:  # noqa: BLE001 - surface indexing failure as API status
            with INDEX_LOCK:
                failed = INDEX_JOBS.setdefault(key, {})
                failed.update(
                    {
                        "version": config.version,
                        "state": "error",
                        "phase": "error",
                        "message": "索引失败",
                        "error": str(exc),
                        "updated_at": time.time(),
                    }
                )
            return
        store.cache_clear()
        term_suggester.cache_clear()
        with INDEX_LOCK:
            done = INDEX_JOBS.setdefault(key, {})
            total_rows = int(done.get("total_rows") or done.get("processed_rows") or 0)
            done.update(
                {
                    "version": config.version,
                    "state": "ready",
                    "phase": "ready",
                    "message": "索引完成",
                    "percent": 100,
                    "processed_rows": total_rows,
                    "total_rows": total_rows,
                    "updated_at": time.time(),
                    "error": "",
                }
            )

    thread = threading.Thread(target=run_index, name=f"meddra-index-{config.version}", daemon=True)
    thread.start()
    return index_status_for_config(config, start=False, force=force)


def index_status_for_version(version: Optional[str] = None, *, start: bool = False, force: bool = False) -> dict[str, Any]:
    config = default_source_config(version)
    return index_status_for_config(config, start=start, force=force)


def require_ready_store(version: Optional[str] = None) -> MeddraStore:
    config = default_source_config(version)
    status = index_status_for_config(config, start=False)
    if status["state"] != "ready":
        raise HTTPException(
            status_code=425,
            detail={
                "error": "index_not_ready",
                "message": "MedDRA词典索引仍在准备，请等待进度条完成后再操作",
                "index": status,
            },
        )
    return store(config)


def pick_dictionary_directory() -> Path | None:
    if os.environ.get("MEDDRA_APP_STORE_MODE") == "1":
        raise RuntimeError("App Store沙盒候选模式需要原生文件夹选择器和安全作用域书签；当前脚本壳不启用AppleScript文件夹选择")

    if sys.platform == "darwin":
        script = 'POSIX path of (choose folder with prompt "请选择MedDRA ASCII词典文件夹或其上级文件夹")'
        command = ["osascript", "-e", script]
    elif sys.platform.startswith("win"):
        ps_script = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$dialog.Description = '请选择MedDRA ASCII词典文件夹或其上级文件夹'; "
            "$dialog.ShowNewFolderButton = $false; "
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
            "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
            "  Write-Output $dialog.SelectedPath "
            "}"
        )
        command = ["powershell", "-NoProfile", "-STA", "-Command", ps_script]
    else:
        raise RuntimeError("当前系统不支持本地文件夹选择器，请使用手动路径导入")

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=300,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("无法打开本地文件夹选择器") from exc

    selected = (result.stdout or "").strip()
    if selected:
        return Path(selected).expanduser()
    stderr = (result.stderr or "").lower()
    if result.returncode == 0 or "cancel" in stderr or "用户已取消" in (result.stderr or ""):
        return None
    raise RuntimeError("本地文件夹选择器已关闭或不可用")


@app.on_event("startup")
def startup() -> None:
    try:
        index_status_for_version(start=True)
    except RuntimeError:
        # Keep the local service alive so Settings can guide the user to add a dictionary folder.
        pass


@lru_cache(maxsize=8)
def store(config: SourceConfig) -> MeddraStore:
    return MeddraStore(config)


@lru_cache(maxsize=8)
def term_suggester(active_store: MeddraStore, source_signature: str) -> TermSuggester:
    return TermSuggester(active_store)


@app.get("/api/status")
def api_status(version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return require_ready_store(version).status()


def runtime_identity_payload() -> dict[str, Any]:
    app_store_mode = os.environ.get("MEDDRA_APP_STORE_MODE") == "1"
    distribution_mode = os.environ.get("MEDDRA_DISTRIBUTION_MODE", "local")
    if app_store_mode:
        distribution_mode = "app_store_candidate"
    instance_id = (os.environ.get("MEDDRA_INSTANCE_ID") or "").strip()
    shutdown_available = callable(getattr(app.state, "request_shutdown", None))
    return {
        "app_name": "MedDRA Browser",
        "version": app.version,
        "app_store_mode": app_store_mode,
        "distribution_mode": distribution_mode,
        "instance_id": instance_id,
        "shutdown_available": shutdown_available,
    }


@app.get("/api/runtime-info")
def api_runtime_info() -> dict[str, Any]:
    # Intentionally JSON-only: portable file:// discovery uses a sidecar or this
    # restricted GET. JSONP is rejected because it would execute in a foreign page.
    return runtime_identity_payload()


@app.post("/api/runtime/shutdown")
async def api_runtime_shutdown(request: Request) -> dict[str, Any]:
    origin = request.headers.get("origin")
    if origin == "null":
        raise HTTPException(status_code=403, detail="file:// 来源不得请求关闭服务")
    if origin is not None and not _origin_permitted(request):
        raise HTTPException(status_code=403, detail="跨站来源不得请求关闭服务")
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type and content_type not in {"application/json", ""}:
        raise HTTPException(status_code=415, detail="shutdown 仅接受 JSON")
    if content_type == "application/json":
        body = await request.body()
        if body.strip() not in {b"", b"{}", b"null"}:
            try:
                json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise HTTPException(status_code=400, detail="shutdown 请求体不是有效 JSON") from exc
    shutdown = getattr(app.state, "request_shutdown", None)
    if not callable(shutdown):
        raise HTTPException(status_code=409, detail="当前运行环境未安装关闭回调")
    shutdown()
    return {"status": "stopping"}


@app.get("/api/index-status")
def api_index_status(
    version: Optional[str] = Query(default=None),
    start: bool = Query(default=False),
    force: bool = Query(default=False),
) -> dict[str, Any]:
    return index_status_for_version(version, start=start, force=force)


@app.get("/api/releases")
def api_releases() -> dict[str, Any]:
    releases = discover_releases()
    return {"releases": [row.as_dict() for row in releases], "search_levels": ALL_SEARCH_LEVELS}


@app.get("/api/source-roots")
def api_source_roots() -> dict[str, Any]:
    return {"roots": source_roots_status()}


@app.post("/api/source-roots")
def api_add_source_root(payload: SourceRootRequest) -> dict[str, Any]:
    try:
        added = add_source_root(payload.path)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.cache_clear()
    term_suggester.cache_clear()
    releases = discover_releases()
    return {
        "status": "added",
        "label": added.name or "已选择来源",
        "releases": [row.as_dict() for row in releases],
        "roots": source_roots_status(),
    }


@app.post("/api/source-roots/pick")
def api_pick_source_root() -> dict[str, Any]:
    try:
        selected = pick_dictionary_directory()
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    if selected is None:
        return {"status": "cancelled", "roots": source_roots_status(), "releases": [row.as_dict() for row in discover_releases()]}
    try:
        added = add_source_root(str(selected))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.cache_clear()
    term_suggester.cache_clear()
    releases = discover_releases()
    return {
        "status": "added",
        "label": added.name or "已选择来源",
        "releases": [row.as_dict() for row in releases],
        "roots": source_roots_status(),
    }


@app.post("/api/reindex")
def api_reindex(version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return index_status_for_version(version, start=True, force=True)


@app.post("/api/search")
def api_search(payload: SearchRequest) -> dict[str, Any]:
    return require_ready_store(payload.version).search(
        payload.query,
        mode=payload.mode,
        levels=payload.levels,
        soc_codes=payload.soc_codes,
        include_synonyms=payload.include_synonyms,
        ignore_diacritics=payload.ignore_diacritics,
        include_non_current=payload.include_non_current,
        limit_per_group=payload.limit_per_group,
        offset_per_group=payload.offset_per_group,
    )


@app.post("/api/advanced-search")
def api_advanced_search(payload: AdvancedSearchRequest) -> dict[str, Any]:
    return require_ready_store(payload.version).advanced_search(payload.model_dump())


@app.get("/api/code/{code}")
def api_code_lookup(code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return require_ready_store(version).code_lookup(code)


@app.get("/api/details/{level}/{code}")
def api_details(level: str, code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    data = require_ready_store(version).details(level, code)
    if not data.get("found"):
        raise HTTPException(status_code=404, detail="术语未找到")
    return data


@app.get("/api/tree/{view}")
def api_tree(
    view: str,
    level: Optional[str] = Query(default=None),
    code: Optional[str] = Query(default=None),
    mode: str = Query(default="both"),
    version: Optional[str] = Query(default=None),
) -> dict[str, Any]:
    return require_ready_store(version).tree(view, level=level, code=code, mode=mode)


@app.get("/api/smq/search")
def api_smq_search(query: str = "", mode: str = "both", version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return require_ready_store(version).smq_search(query, mode)


@app.get("/api/smq/{smq_code}")
def api_smq_details(smq_code: str, mode: str = "both", version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    data = require_ready_store(version).smq_details(smq_code, mode)
    if not data.get("found"):
        raise HTTPException(status_code=404, detail="SMQ未找到")
    return data


@app.get("/api/synonyms")
def api_synonyms(
    lang: str = Query(default="en"),
    limit: int = Query(default=500, ge=1, le=2000),
    version: Optional[str] = Query(default=None),
) -> dict[str, Any]:
    return require_ready_store(version).synonyms(lang=lang, limit=limit)


@app.get("/api/analysis/hierarchy/{level}/{code}")
def api_hierarchy_analysis(level: str, code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return require_ready_store(version).hierarchy_analysis(code, level)


@app.get("/api/analysis/smq/{level}/{code}")
def api_smq_analysis(level: str, code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return require_ready_store(version).smq_analysis(code, level)


@app.post("/api/export/csv")
def api_export_csv(payload: ExportRequest) -> Response:
    # Pure CSV formatting — does not require a bound MedDRA index.
    csv_text = code_to_csv(payload.rows)
    if csv_text and not csv_text.startswith("\ufeff"):
        # Excel on Chinese Windows defaults to the GBK codepage and garbles UTF-8
        # Chinese terms unless the file starts with a UTF-8 BOM.
        csv_text = f"\ufeff{csv_text}"
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": content_disposition_attachment(payload.filename, "meddra_export.csv")},
    )


@app.post("/api/coding/import")
def api_coding_import(payload: CodingImportRequest) -> dict[str, Any]:
    if not payload.content_base64:
        raise HTTPException(status_code=400, detail="未收到文件内容")
    # Reject oversized base64 before decoding to avoid multi-hundred-MB spikes.
    if len(payload.content_base64) > 110 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件过大，请控制在 80MB 以内")
    try:
        content = base64.b64decode(payload.content_base64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="文件内容不是有效的 base64") from exc
    if not content:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(content) > 80 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件过大，请控制在 80MB 以内")
    filename = payload.filename or "listing.xlsx"
    try:
        if filename.lower().endswith(".csv"):
            parsed = parse_data_listing_csv(content, filename)
        else:
            parsed = parse_data_listing_excel(content, filename)
    except Exception as exc:  # noqa: BLE001 - surface parse failure as a readable API error
        raise HTTPException(status_code=400, detail=f"解析失败：{exc}") from exc
    return parsed


@app.post("/api/coding/suggest")
def api_coding_suggest(payload: CodingSuggestRequest) -> dict[str, Any]:
    if not payload.terms:
        return {"suggestions": {}, "count": 0, "version": payload.version, "status": "suggested"}
    if len(payload.terms) > 2000:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "suggest_batch_too_large",
                "message": "一次最多建议 2000 个唯一术语，请前端分块提交",
                "max_terms": 2000,
                "received": len(payload.terms),
            },
        )
    try:
        active_store = require_ready_store(payload.version)
        identity = active_store.index_identity()
        # Warm/reuse the per-version suggester so repeated batches do not
        # re-normalize the entire PT/LLT table.
        suggester = term_suggester(active_store, identity["source_signature"])
        suggestions = suggester.suggest_batch(
            payload.terms,
            mode=payload.mode,
            limit_per_term=payload.limit_per_term,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"批量建议失败：{exc}") from exc
    current_identity = require_ready_store(identity["version"]).index_identity()
    check_coding_index(current_identity, identity["version"], identity["source_signature"])
    # Suggestions are candidates only; clients must keep decisions pending until review.
    return {
        "suggestions": suggestions,
        "count": len(suggestions),
        "version": identity["version"],
        "available_languages": identity["available_languages"],
        "source_signature": identity["source_signature"],
        "index_identity": identity,
        "auto_accept": False,
    }


def check_coding_index(identity: dict[str, Any], version: str, signature: str) -> None:
    if identity["source_signature"] != signature or identity["version"] != version:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "index_identity_mismatch",
                "message": "当前词典版本或索引已变更，请重新建议并复审",
                "index_identity": identity,
            },
        )


@app.post("/api/coding/validate")
def api_coding_validate(payload: CodingValidateRequest) -> dict[str, Any]:
    if not payload.version or not payload.source_signature:
        raise HTTPException(
            status_code=400,
            detail={"error": "export_identity_required", "message": "编码校验需要词典版本和索引签名"},
        )
    active_store = require_ready_store(payload.version)
    with active_store.connect() as con:
        con.execute("BEGIN")
        identity = active_store.index_identity(con)
        check_coding_index(identity, payload.version, payload.source_signature)
        lookup = partial(active_store.term_by_code, con=con)
        results = {key: validate_coding_pair(lookup, decision) for key, decision in payload.decisions.items()}
    current_identity = require_ready_store(payload.version).index_identity()
    check_coding_index(current_identity, payload.version, payload.source_signature)
    return {
        "version": identity["version"],
        "source_signature": identity["source_signature"],
        "index_identity": identity,
        "results": results,
        "ok_count": sum(1 for item in results.values() if item.get("ok")),
        "error_count": sum(1 for item in results.values() if not item.get("ok")),
    }


@app.post("/api/coding/export")
def api_coding_export(payload: CodingExportRequest) -> Response:
    export_mode = (payload.export_mode or "coded").strip().lower()
    if export_mode not in {"coded", "exceptions", "both"}:
        raise HTTPException(status_code=400, detail="export_mode 仅支持 coded / exceptions / both")
    dictionary_version = payload.dictionary_version or ""
    source_signature = payload.source_signature or ""
    try:
        if export_mode == "exceptions":
            bundle = build_export_bundle(payload.unique_terms, payload.decisions)
            dictionary_version = source_signature = ""
        else:
            if not dictionary_version or not source_signature:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "export_identity_required", "message": "正式导出需要词典版本和索引签名"},
                )
            ready_store = require_ready_store(dictionary_version)
            with ready_store.connect() as con:
                con.execute("BEGIN")
                check_coding_index(ready_store.index_identity(con), dictionary_version, source_signature)
                lookup = lru_cache(maxsize=4096)(partial(ready_store.term_by_code, con=con))
                bundle = build_export_bundle(
                    payload.unique_terms,
                    payload.decisions,
                    dictionary_version=dictionary_version,
                    lookup=lookup,
                    source_signature=source_signature,
                )
            current_identity = require_ready_store(dictionary_version).index_identity()
            check_coding_index(current_identity, dictionary_version, source_signature)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if export_mode == "coded":
        rows = bundle["coded_rows"]
        default_name = "meddra_coded_listing.csv"
        if not rows:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "no_confirmed_codes",
                    "message": "没有已人工确认的编码行可导出；pending/rejected 请改用 export_mode=exceptions",
                    "stats": bundle["stats"],
                },
            )
    elif export_mode == "exceptions":
        rows = bundle["exception_rows"]
        default_name = "meddra_coding_exceptions.csv"
    else:
        rows = list(bundle["coded_rows"]) + list(bundle["exception_rows"])
        default_name = "meddra_coding_export.csv"
        if not rows:
            raise HTTPException(status_code=409, detail={"error": "empty_export", "stats": bundle["stats"]})
    csv_text = code_to_csv(rows, include_coding=export_mode != "exceptions")
    if csv_text and not csv_text.startswith("\ufeff"):
        csv_text = f"\ufeff{csv_text}"
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": content_disposition_attachment(payload.filename, default_name),
            "X-MedDRA-Export-Mode": export_mode,
            "X-MedDRA-Coded-Rows": str(bundle["stats"]["coded_row_count"]),
            "X-MedDRA-Exception-Rows": str(bundle["stats"]["exception_row_count"]),
            "X-MedDRA-Version": dictionary_version,
            "X-MedDRA-Source-Signature": source_signature,
        },
    )


@app.get("/")
def app_index() -> FileResponse:
    index = FRONTEND_DIST / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="前端尚未构建，请先运行 npm run build")
    return FileResponse(index)


@app.head("/")
def app_index_head() -> Response:
    index = FRONTEND_DIST / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="前端尚未构建，请先运行 npm run build")
    return Response(status_code=200, headers={"Content-Type": "text/html; charset=utf-8"})


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
def app_static_fallback(path: str) -> Response:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API路径不存在")
    target = (FRONTEND_DIST / path).resolve()
    if FRONTEND_DIST in target.parents and target.is_file():
        # FileResponse omits the body for HEAD requests.
        return FileResponse(target)
    return app_index()
