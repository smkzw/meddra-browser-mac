from __future__ import annotations

from functools import lru_cache
from pathlib import Path
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

app = FastAPI(title="MedDRA Browser Mac", version="0.1.3")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.exception_handler(RuntimeError)
async def runtime_error_handler(request: Request, exc: RuntimeError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"error": "meddra_data_unavailable", "detail": str(exc)},
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


@app.on_event("startup")
def startup() -> None:
    try:
        MeddraIndexer().ensure_index()
    except RuntimeError:
        # Keep the local service alive so Settings can guide the user to add a dictionary folder.
        pass


@lru_cache(maxsize=8)
def store(version: Optional[str] = None) -> MeddraStore:
    return MeddraStore(default_source_config(version))


@app.get("/api/status")
def api_status(version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return store(version).status()


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
        "path": str(added),
        "releases": [row.as_dict() for row in releases],
        "roots": source_roots_status(),
    }


@app.post("/api/reindex")
def api_reindex(version: Optional[str] = Query(default=None)) -> dict[str, str]:
    config = default_source_config(version)
    MeddraIndexer(config).ensure_index(force=True)
    store.cache_clear()
    return {"status": "rebuilt", "version": config.version}


@app.post("/api/search")
def api_search(payload: SearchRequest) -> dict[str, Any]:
    return store(payload.version).search(
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
    return store(payload.version).advanced_search(payload.model_dump())


@app.get("/api/code/{code}")
def api_code_lookup(code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return store(version).code_lookup(code)


@app.get("/api/details/{level}/{code}")
def api_details(level: str, code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    data = store(version).details(level, code)
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
    return store(version).tree(view, level=level, code=code, mode=mode)


@app.get("/api/smq/search")
def api_smq_search(query: str = "", mode: str = "both", version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return store(version).smq_search(query, mode)


@app.get("/api/smq/{smq_code}")
def api_smq_details(smq_code: str, mode: str = "both", version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    data = store(version).smq_details(smq_code, mode)
    if not data.get("found"):
        raise HTTPException(status_code=404, detail="SMQ未找到")
    return data


@app.get("/api/synonyms")
def api_synonyms(
    lang: str = Query(default="en"),
    limit: int = Query(default=500, ge=1, le=2000),
    version: Optional[str] = Query(default=None),
) -> dict[str, Any]:
    return store(version).synonyms(lang=lang, limit=limit)


@app.get("/api/analysis/hierarchy/{level}/{code}")
def api_hierarchy_analysis(level: str, code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return store(version).hierarchy_analysis(code, level)


@app.get("/api/analysis/smq/{level}/{code}")
def api_smq_analysis(level: str, code: str, version: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return store(version).smq_analysis(code, level)


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
