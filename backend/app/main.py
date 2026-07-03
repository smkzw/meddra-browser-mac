from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .meddra_data import (
    ALL_SEARCH_LEVELS,
    MeddraIndexer,
    MeddraStore,
    add_source_root,
    default_source_config,
    discover_releases,
    source_roots_status,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"

app = FastAPI(title="MedDRA Browser Mac", version="0.1.9")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "null"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


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
    limit_per_group: int = 60


class AdvancedCondition(BaseModel):
    value: str = ""
    operator: str = "contains"


class AdvancedSearchRequest(BaseModel):
    version: Optional[str] = None
    mode: str = "both"
    levels: list[str] = ["PT"]
    boolean: str = "AND"
    conditions: list[AdvancedCondition]


class ExportRequest(BaseModel):
    rows: list[dict[str, Any]]
    filename: str = "meddra_export.csv"


class SourceRootRequest(BaseModel):
    path: str


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
            if current and current.get("state") == "ready":
                return public_index_status(current)
        status = ready_index_status(config)
        with INDEX_LOCK:
            INDEX_JOBS[key] = status
        return status

    with INDEX_LOCK:
        current = INDEX_JOBS.get(key)
        if not start:
            return public_index_status(current) if current else pending_index_status(config)
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
    return store(version)


def pick_dictionary_directory() -> Path | None:
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
        result = subprocess.run(command, capture_output=True, text=True, timeout=300, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("无法打开本地文件夹选择器") from exc

    selected = result.stdout.strip()
    if selected:
        return Path(selected).expanduser()
    if result.returncode == 0 or "cancel" in result.stderr.lower():
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
def store(version: Optional[str] = None) -> MeddraStore:
    return MeddraStore(default_source_config(version))


@app.get("/api/status")
def api_status(version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return require_ready_store(version).status()


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
    csv_text = store().export_csv(payload.rows)
    filename = Path(payload.filename).name or "meddra_export.csv"
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/")
def app_index() -> FileResponse:
    index = FRONTEND_DIST / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="前端尚未构建，请先运行 npm run build")
    return FileResponse(index)


@app.get("/{path:path}")
def app_static_fallback(path: str) -> FileResponse:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API路径不存在")
    target = (FRONTEND_DIST / path).resolve()
    if FRONTEND_DIST in target.parents and target.is_file():
        return FileResponse(target)
    return app_index()
