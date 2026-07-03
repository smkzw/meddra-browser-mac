from __future__ import annotations

import csv
import io
import json
import os
import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from hashlib import sha1
from pathlib import Path
from typing import Any, Iterable


LEVELS = ["SOC", "HLGT", "HLT", "PT", "LLT"]
ALL_SEARCH_LEVELS = [*LEVELS, "SMQ"]
INDEX_SIGNATURE_VERSION = "0.1.4-source-signature-v1"
REQUIRED_ASC_FILES = {
    "soc.asc",
    "hlgt.asc",
    "hlt.asc",
    "pt.asc",
    "llt.asc",
    "mdhier.asc",
    "hlt_pt.asc",
    "hlgt_hlt.asc",
    "soc_hlgt.asc",
    "smq_list.asc",
    "smq_content.asc",
}
OPTIONAL_ASC_FILES = {"intl_ord.asc"}
LEVEL_LABELS = {
    "SOC": "系统器官分类",
    "HLGT": "高位组语",
    "HLT": "高位语",
    "PT": "首选语",
    "LLT": "低位语",
    "SMQ": "标准MedDRA查询",
}

SEARCH_LABELS = {
    "exact": "完全匹配",
    "lexical": "词序变体",
    "synonym": "同义词扩展",
    "contains": "包含匹配",
    "prefix_suffix": "开头/结尾匹配",
    "code": "代码匹配",
    "fuzzy": "模糊候选",
    "smq": "SMQ匹配",
}

SCOPE_LABELS = {"1": "广义", "2": "狭义"}


@dataclass(frozen=True)
class ReleaseInfo:
    version: str
    english_dir: Path | None
    chinese_dir: Path | None

    @property
    def complete(self) -> bool:
        return self.english_dir is not None and self.chinese_dir is not None

    @property
    def missing_languages(self) -> tuple[str, ...]:
        missing: list[str] = []
        if self.english_dir is None:
            missing.append("en")
        if self.chinese_dir is None:
            missing.append("zh")
        return tuple(missing)

    @property
    def available_languages(self) -> tuple[str, ...]:
        langs: list[str] = []
        if self.english_dir is not None:
            langs.append("en")
        if self.chinese_dir is not None:
            langs.append("zh")
        return tuple(langs)

    @property
    def usable(self) -> bool:
        return bool(self.available_languages)

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "complete": self.complete,
            "usable": self.usable,
            "available_languages": list(self.available_languages),
            "missing_languages": list(self.missing_languages),
        }


@dataclass(frozen=True)
class SourceConfig:
    root: Path
    version: str
    english_dir: Path | None
    chinese_dir: Path | None
    synonym_english: Path
    synonym_chinese: Path
    db_path: Path
    available_versions: tuple[ReleaseInfo, ...] = ()


def default_source_config(version: str | None = None, root: Path | None = None) -> SourceConfig:
    med_root = root.expanduser() if root else default_med_root()
    releases = discover_releases(med_root if root else None)
    if not releases:
        raise RuntimeError("未发现可用的MedDRA ASCII词典目录，请在设置中加入词典来源")
    selected = select_release(releases, version)
    source_root = selected.english_dir or selected.chinese_dir or med_root
    db_name = f"meddra_{version_slug(selected.version)}.sqlite"
    if not selected.complete:
        token = "|".join(str(item) for item in [selected.english_dir, selected.chinese_dir] if item)
        digest = sha1(token.encode("utf-8")).hexdigest()[:8]
        db_name = f"meddra_{version_slug(selected.version)}_{'_'.join(selected.available_languages)}_{digest}.sqlite"
    return SourceConfig(
        root=source_root,
        version=selected.version,
        english_dir=selected.english_dir,
        chinese_dir=selected.chinese_dir,
        synonym_english=default_synonym_root(source_root, selected) / "meddra_synonym_english.asc",
        synonym_chinese=default_synonym_root(source_root, selected) / "meddra_synonym_chinese.asc",
        db_path=project_data_dir() / db_name,
        available_versions=tuple(releases),
    )


def default_med_root() -> Path:
    env_root = os.environ.get("MEDDRA_SOURCE_ROOT")
    if env_root:
        return Path(env_root).expanduser()
    project_root = Path(__file__).resolve().parents[2]
    portable_root = project_root / "dictionaries"
    app_support_root = Path.home() / "Library" / "Application Support" / "MedDRA Browser Mac" / "dictionaries"
    documents_root = Path.home() / "Documents" / "MedDRA"
    for candidate in [portable_root, app_support_root, documents_root]:
        if contains_meddra_ascii(candidate):
            return candidate
    if portable_root.exists():
        return portable_root
    return app_support_root


def contains_meddra_ascii(root: Path) -> bool:
    if not root.exists() or not root.is_dir():
        return False
    try:
        next(root.rglob("soc.asc"))
    except (StopIteration, OSError):
        return False
    return True


def has_synonym_files(root: Path) -> bool:
    return (root / "meddra_synonym_english.asc").exists() or (root / "meddra_synonym_chinese.asc").exists()


def synonym_candidates(base: Path) -> Iterable[Path]:
    yield base
    yield base / "MDB4"
    yield base / "MDB41_D241_B123"
    try:
        for child in base.iterdir():
            if child.is_dir() and child.name.upper().startswith("MDB"):
                yield child
    except (OSError, PermissionError):
        return


def default_synonym_root(med_root: Path, release: ReleaseInfo | None = None) -> Path:
    env_root = os.environ.get("MEDDRA_SYNONYM_ROOT")
    if env_root:
        return Path(env_root).expanduser()
    project_root = Path(__file__).resolve().parents[2]
    bases: list[Path] = []
    for item in [release.english_dir if release else None, release.chinese_dir if release else None, med_root]:
        if item is None:
            continue
        for base in [item, item.parent, item.parent.parent]:
            if base not in bases:
                bases.append(base)
    bases.extend([project_root / "dictionaries", default_med_root()])

    candidates: list[Path] = []
    for base in bases:
        for candidate in synonym_candidates(base):
            if candidate not in candidates:
                candidates.append(candidate)
    for candidate in candidates:
        if has_synonym_files(candidate):
            return candidate
    return candidates[0] if candidates else med_root


def project_data_dir() -> Path:
    env_root = os.environ.get("MEDDRA_BROWSER_STATE_DIR")
    if env_root:
        return Path(env_root).expanduser()
    return Path(__file__).resolve().parents[2] / "backend" / "data"


def source_roots_file() -> Path:
    return project_data_dir() / "source_roots.json"


def load_source_roots() -> list[Path]:
    path = source_roots_file()
    if not path.exists():
        return []
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    roots: list[Path] = []
    for item in rows if isinstance(rows, list) else []:
        raw = item.get("path") if isinstance(item, dict) else item
        if not raw:
            continue
        candidate = Path(str(raw)).expanduser()
        if candidate not in roots:
            roots.append(candidate)
    return roots


def configured_source_roots(root: Path | None = None) -> list[Path]:
    roots = [root or default_med_root(), *load_source_roots()]
    unique: list[Path] = []
    for item in roots:
        resolved = item.expanduser()
        if resolved not in unique:
            unique.append(resolved)
    return unique


def add_source_root(path: str) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.exists() or not candidate.is_dir():
        raise RuntimeError("目录不存在或不可读取")
    if not discover_releases(candidate):
        raise RuntimeError("未在所选文件夹或其子文件夹中发现可用的MedDRA ASCII词典目录")
    roots = load_source_roots()
    if candidate not in roots and candidate != default_med_root():
        roots.append(candidate)
    source_roots_file().parent.mkdir(parents=True, exist_ok=True)
    source_roots_file().write_text(
        json.dumps([{"path": str(item)} for item in roots], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return candidate


def source_roots_status() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, root in enumerate(configured_source_roots(), start=1):
        releases = discover_releases(root)
        rows.append(
            {
                "id": f"source-{index}",
                "label": f"词典来源 {index}",
                "exists": root.exists(),
                "release_count": len(releases),
                "releases": [release.as_dict() for release in releases],
            }
        )
    return rows


def discover_releases(root: Path | None = None) -> list[ReleaseInfo]:
    roots = configured_source_roots(root) if root is None else [root.expanduser()]
    by_version: dict[str, dict[str, Path]] = {}
    for med_root in roots:
        if not med_root.exists():
            continue
        for base in iter_dictionary_dirs(med_root):
            if "meddra-browser-mac" in base.parts:
                continue
            names = {path.name for path in base.glob("*.asc")}
            if not REQUIRED_ASC_FILES.issubset(names):
                continue
            lang = infer_language(base) or infer_language_from_content(base)
            version = infer_version(base)
            if not lang or not version:
                continue
            by_version.setdefault(version, {}).setdefault(lang, base)
    releases = [
        ReleaseInfo(version=item, english_dir=paths.get("en"), chinese_dir=paths.get("zh"))
        for item, paths in by_version.items()
    ]
    return sorted(releases, key=lambda row: version_key(row.version), reverse=True)


def iter_dictionary_dirs(root: Path) -> Iterable[Path]:
    if (root / "soc.asc").exists():
        yield root
        return
    try:
        soc_files = root.rglob("soc.asc")
        for soc_file in soc_files:
            yield soc_file.parent
    except (OSError, PermissionError):
        return


def select_release(releases: list[ReleaseInfo], version: str | None = None) -> ReleaseInfo:
    requested = normalize_version(version) if version else None
    if requested:
        for release in releases:
            if release.version == requested:
                if not release.usable:
                    raise RuntimeError(f"MedDRA {requested} 没有可用语言包")
                return release
        available = ", ".join(row.version for row in releases) or "无"
        raise RuntimeError(f"未找到 MedDRA {requested}；本地版本: {available}")
    for release in releases:
        if release.usable:
            return release
    available = ", ".join(f"{row.version}({','.join(row.missing_languages)})" for row in releases)
    raise RuntimeError(f"未找到可用的MedDRA版本；本地版本: {available}")


def infer_language(path: Path) -> str | None:
    lowered = " ".join(part.lower() for part in path.parts)
    if "chinese" in lowered or "chn" in lowered or " chn" in lowered:
        return "zh"
    if "english" in lowered or "eng" in lowered or path.name.lower() == "medascii":
        return "en"
    if path.name.lower().startswith("ascii-"):
        return "zh"
    return None


def infer_language_from_content(path: Path) -> str | None:
    try:
        sample_rows = read_asc(path / "soc.asc")[:5]
    except (OSError, RuntimeError):
        return None
    text = " ".join(part for row in sample_rows for part in row[1:3])
    if re.search(r"[\u4e00-\u9fff]", text):
        return "zh"
    if re.search(r"[A-Za-z]", text):
        return "en"
    return None


def infer_version(path: Path) -> str | None:
    for part in [path.name, *[parent.name for parent in path.parents]]:
        version = parse_version_text(part)
        if version:
            return version
    return None


def parse_version_text(text: str) -> str | None:
    normalized = text.replace("-", "_")
    ascii_match = re.search(r"ascii_(\d{3})", normalized, flags=re.IGNORECASE)
    if ascii_match:
        digits = ascii_match.group(1)
        return normalize_version(f"{int(digits[:2])}.{int(digits[2])}")
    meddra_match = re.search(r"MedDRA_(\d{2})_(\d+)", normalized, flags=re.IGNORECASE)
    if meddra_match:
        return normalize_version(f"{meddra_match.group(1)}.{meddra_match.group(2)}")
    package_match = re.fullmatch(r"(\d{2})_(\d+)_(ENG|CHN)", normalized, flags=re.IGNORECASE)
    if package_match:
        return normalize_version(f"{package_match.group(1)}.{package_match.group(2)}")
    whole_match = re.fullmatch(r"(\d{2})_(ENG|CHN|Eng|Chn)", normalized, flags=re.IGNORECASE)
    if whole_match:
        return normalize_version(f"{whole_match.group(1)}.0")
    return None


def normalize_version(version: str | None) -> str:
    if not version:
        return ""
    match = re.search(r"(\d{1,2})[._-](\d+)", version)
    if not match:
        return version.strip()
    return f"{int(match.group(1))}.{int(match.group(2))}"


def version_key(version: str) -> tuple[int, int]:
    normalized = normalize_version(version)
    major, _, minor = normalized.partition(".")
    return (int(major or 0), int(minor or 0))


def version_slug(version: str) -> str:
    return normalize_version(version).replace(".", "_")


def normalize_text(value: str, *, ignore_diacritics: bool = True) -> str:
    value = (value or "").strip().lower()
    if ignore_diacritics:
        value = "".join(
            ch
            for ch in unicodedata.normalize("NFD", value)
            if unicodedata.category(ch) != "Mn"
        )
    value = value.replace("β", "beta")
    value = re.sub(r"\s+", " ", value)
    return value


def token_key(value: str) -> str:
    tokens = [t for t in re.split(r"[^a-z0-9]+", normalize_text(value)) if t]
    return " ".join(sorted(tokens))


def read_asc(path: Path) -> list[list[str]]:
    encodings = ["utf-8-sig", "utf-8", "latin1"]
    last_error: Exception | None = None
    for encoding in encodings:
        try:
            rows: list[list[str]] = []
            with path.open("r", encoding=encoding, newline="") as handle:
                for line in handle:
                    line = line.rstrip("\r\n")
                    if not line:
                        continue
                    rows.append(split_dollar_line(line))
            return rows
        except UnicodeDecodeError as exc:
            last_error = exc
    raise RuntimeError(f"无法读取 {path}: {last_error}")


def split_dollar_line(line: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    in_quotes = False
    for ch in line:
        if ch == '"':
            in_quotes = not in_quotes
            current.append(ch)
        elif ch == "$" and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


class MeddraIndexer:
    def __init__(self, config: SourceConfig | None = None):
        self.config = config or default_source_config()

    def ensure_index(self, *, force: bool = False) -> None:
        if self.config.db_path.exists():
            if force or not self._index_is_current():
                self._delete_index()
            else:
                return
        language_dirs = self._language_dirs()
        if not language_dirs:
            raise RuntimeError("未配置可用的英文或中文MedDRA ASCII目录")
        self.config.db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.config.db_path) as con:
            con.row_factory = sqlite3.Row
            self._create_schema(con)
            for index, (lang, base) in enumerate(language_dirs):
                self._load_language(con, lang, base, load_smq_content=index == 0)
            self._merge_terms(con)
            self._load_synonyms(con)
            self._build_fts(con)
            self._write_metadata(con)
            con.commit()

    def _source_signature(self) -> str:
        parts = [INDEX_SIGNATURE_VERSION, f"version:{self.config.version}"]
        for lang, base in self._language_dirs():
            parts.append(f"lang:{lang}:{base.resolve()}")
            for file_name in sorted(REQUIRED_ASC_FILES):
                path = base / file_name
                try:
                    stat = path.stat()
                except OSError:
                    parts.append(f"{lang}:{file_name}:missing")
                    continue
                parts.append(f"{lang}:{file_name}:{stat.st_size}:{stat.st_mtime_ns}")
        for lang, path in [("en", self.config.synonym_english), ("zh", self.config.synonym_chinese)]:
            try:
                stat = path.stat()
            except OSError:
                parts.append(f"synonym:{lang}:missing")
                continue
            parts.append(f"synonym:{lang}:{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}")
        return sha1("\n".join(parts).encode("utf-8")).hexdigest()

    def _index_is_current(self) -> bool:
        try:
            with sqlite3.connect(self.config.db_path) as con:
                row = con.execute(
                    "select value from index_metadata where key='source_signature'"
                ).fetchone()
        except sqlite3.DatabaseError:
            return False
        return bool(row and row[0] == self._source_signature())

    def _write_metadata(self, con: sqlite3.Connection) -> None:
        con.execute(
            "insert or replace into index_metadata values (?, ?)",
            ("source_signature", self._source_signature()),
        )

    def _delete_index(self) -> None:
        for path in [
            self.config.db_path,
            self.config.db_path.with_name(f"{self.config.db_path.name}-wal"),
            self.config.db_path.with_name(f"{self.config.db_path.name}-shm"),
        ]:
            try:
                path.unlink()
            except FileNotFoundError:
                continue

    def _language_dirs(self) -> list[tuple[str, Path]]:
        rows: list[tuple[str, Path]] = []
        if self.config.english_dir:
            rows.append(("en", self.config.english_dir))
        if self.config.chinese_dir:
            rows.append(("zh", self.config.chinese_dir))
        return rows

    def _create_schema(self, con: sqlite3.Connection) -> None:
        con.executescript(
            """
            pragma journal_mode = wal;
            drop table if exists source_counts;
            drop table if exists raw_terms;
            drop table if exists terms;
            drop table if exists hierarchy;
            drop table if exists relations;
            drop table if exists smq_list_raw;
            drop table if exists smq;
            drop table if exists smq_content;
            drop table if exists synonyms;
            drop table if exists term_soc;
            drop table if exists soc_order;
            drop table if exists index_metadata;
            drop table if exists terms_fts;

            create table source_counts(
                lang text not null,
                file_name text not null,
                row_count integer not null,
                primary key(lang, file_name)
            );

            create table raw_terms(
                lang text not null,
                level text not null,
                code text not null,
                name text not null,
                parent_code text,
                is_current text,
                abbrev text,
                primary key(lang, level, code)
            );

            create table terms(
                level text not null,
                code text not null,
                en_name text,
                zh_name text,
                parent_code text,
                is_current text,
                abbrev text,
                primary key(level, code)
            );

            create table hierarchy(
                lang text not null,
                pt_code text not null,
                hlt_code text not null,
                hlgt_code text not null,
                soc_code text not null,
                pt_name text not null,
                hlt_name text not null,
                hlgt_name text not null,
                soc_name text not null,
                soc_abbrev text,
                primary_soc text,
                occurrence_key text primary key
            );

            create table relations(
                lang text not null,
                relation text not null,
                parent_code text not null,
                child_code text not null,
                primary key(lang, relation, parent_code, child_code)
            );

            create table smq_list_raw(
                lang text not null,
                smq_code text not null,
                smq_name text not null,
                smq_level text,
                description text,
                source text,
                note text,
                version text,
                status text,
                algorithmic text,
                primary key(lang, smq_code)
            );

            create table smq(
                smq_code text primary key,
                en_name text,
                zh_name text,
                smq_level text,
                en_description text,
                zh_description text,
                en_source text,
                zh_source text,
                en_note text,
                zh_note text,
                version text,
                status text,
                algorithmic text
            );

            create table smq_content(
                smq_code text not null,
                term_code text not null,
                term_level text,
                scope text,
                category text,
                weight text,
                status text,
                add_version text,
                last_version text,
                primary key(smq_code, term_code, term_level, scope, category)
            );

            create table synonyms(
                lang text not null,
                phrase text not null,
                synonym_group text not null,
                weight integer,
                primary key(lang, phrase, synonym_group)
            );

            create table term_soc(
                level text not null,
                code text not null,
                soc_code text not null,
                primary_soc text,
                primary key(level, code, soc_code)
            );

            create table soc_order(
                lang text not null,
                soc_code text not null,
                sort_order integer not null,
                primary key(lang, soc_code)
            );

            create table index_metadata(
                key text primary key,
                value text not null
            );
            """
        )

    def _load_language(self, con: sqlite3.Connection, lang: str, base: Path, *, load_smq_content: bool) -> None:
        required = [
            "soc.asc",
            "hlgt.asc",
            "hlt.asc",
            "pt.asc",
            "llt.asc",
            "mdhier.asc",
            "hlt_pt.asc",
            "hlgt_hlt.asc",
            "soc_hlgt.asc",
            "smq_list.asc",
            "smq_content.asc",
        ]
        for name in required:
            rows = read_asc(base / name)
            con.execute(
                "insert into source_counts(lang, file_name, row_count) values (?, ?, ?)",
                (lang, name, len(rows)),
            )
        if (base / "intl_ord.asc").exists():
            rows = read_asc(base / "intl_ord.asc")
            con.execute(
                "insert into source_counts(lang, file_name, row_count) values (?, ?, ?)",
                (lang, "intl_ord.asc", len(rows)),
            )
        self._load_terms(con, lang, base)
        self._load_hierarchy(con, lang, base)
        self._load_relations(con, lang, base)
        self._load_soc_order(con, lang, base)
        self._load_smq(con, lang, base, load_smq_content=load_smq_content)

    def _load_terms(self, con: sqlite3.Connection, lang: str, base: Path) -> None:
        for parts in read_asc(base / "soc.asc"):
            con.execute(
                "insert into raw_terms values (?, 'SOC', ?, ?, null, null, ?)",
                (lang, parts[0], parts[1], parts[2] if len(parts) > 2 else ""),
            )
        for filename, level in [("hlgt.asc", "HLGT"), ("hlt.asc", "HLT")]:
            for parts in read_asc(base / filename):
                con.execute(
                    "insert into raw_terms values (?, ?, ?, ?, null, null, null)",
                    (lang, level, parts[0], parts[1]),
                )
        for parts in read_asc(base / "pt.asc"):
            con.execute(
                "insert into raw_terms values (?, 'PT', ?, ?, null, 'Y', null)",
                (lang, parts[0], parts[1]),
            )
        for parts in read_asc(base / "llt.asc"):
            con.execute(
                "insert into raw_terms values (?, 'LLT', ?, ?, ?, ?, null)",
                (
                    lang,
                    parts[0],
                    parts[1],
                    parts[2] if len(parts) > 2 else "",
                    parts[9] if len(parts) > 9 else "Y",
                ),
            )

    def _load_hierarchy(self, con: sqlite3.Connection, lang: str, base: Path) -> None:
        for idx, parts in enumerate(read_asc(base / "mdhier.asc")):
            if len(parts) < 12:
                continue
            occurrence_key = f"{lang}:{idx}:{parts[0]}:{parts[3]}"
            con.execute(
                """
                insert into hierarchy values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lang,
                    parts[0],
                    parts[1],
                    parts[2],
                    parts[3],
                    parts[4],
                    parts[5],
                    parts[6],
                    parts[7],
                    parts[8],
                    parts[11] or "N",
                    occurrence_key,
                ),
            )

    def _load_relations(self, con: sqlite3.Connection, lang: str, base: Path) -> None:
        relation_files = [
            ("soc_hlgt.asc", "SOC_HLGT"),
            ("hlgt_hlt.asc", "HLGT_HLT"),
            ("hlt_pt.asc", "HLT_PT"),
        ]
        for filename, relation in relation_files:
            for parts in read_asc(base / filename):
                if len(parts) >= 2:
                    con.execute(
                        "insert or ignore into relations values (?, ?, ?, ?)",
                        (lang, relation, parts[0], parts[1]),
                    )
        for parts in read_asc(base / "llt.asc"):
            if len(parts) >= 3:
                con.execute(
                    "insert or ignore into relations values (?, 'PT_LLT', ?, ?)",
                    (lang, parts[2], parts[0]),
                )

    def _load_soc_order(self, con: sqlite3.Connection, lang: str, base: Path) -> None:
        path = base / "intl_ord.asc"
        if not path.exists():
            return
        for parts in read_asc(path):
            if len(parts) < 2:
                continue
            try:
                sort_order = int(parts[0])
            except ValueError:
                sort_order = 999
            con.execute(
                "insert or ignore into soc_order values (?, ?, ?)",
                (lang, parts[1], sort_order),
            )

    def _load_smq(self, con: sqlite3.Connection, lang: str, base: Path, *, load_smq_content: bool) -> None:
        for parts in read_asc(base / "smq_list.asc"):
            padded = parts + [""] * 10
            con.execute(
                "insert into smq_list_raw values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    lang,
                    padded[0],
                    padded[1],
                    padded[2],
                    padded[3],
                    padded[4],
                    padded[5],
                    padded[6],
                    padded[7],
                    padded[8],
                ),
            )
        if load_smq_content:
            for parts in read_asc(base / "smq_content.asc"):
                padded = parts + [""] * 10
                con.execute(
                    "insert or ignore into smq_content values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    tuple(padded[:9]),
                )

    def _merge_terms(self, con: sqlite3.Connection) -> None:
        con.execute(
            """
            insert into terms(level, code, en_name, zh_name, parent_code, is_current, abbrev)
            select
                coalesce(en.level, zh.level) as level,
                coalesce(en.code, zh.code) as code,
                en.name as en_name,
                zh.name as zh_name,
                coalesce(en.parent_code, zh.parent_code) as parent_code,
                coalesce(en.is_current, zh.is_current) as is_current,
                coalesce(en.abbrev, zh.abbrev) as abbrev
            from raw_terms en
            left join raw_terms zh
              on zh.lang = 'zh' and zh.level = en.level and zh.code = en.code
            where en.lang = 'en'
            union
            select
                zh.level,
                zh.code,
                en.name,
                zh.name,
                coalesce(en.parent_code, zh.parent_code),
                coalesce(en.is_current, zh.is_current),
                coalesce(en.abbrev, zh.abbrev)
            from raw_terms zh
            left join raw_terms en
              on en.lang = 'en' and en.level = zh.level and en.code = zh.code
            where zh.lang = 'zh' and en.code is null
            """
        )
        con.execute(
            """
            insert into smq
            select
                coalesce(en.smq_code, zh.smq_code),
                en.smq_name,
                zh.smq_name,
                coalesce(en.smq_level, zh.smq_level),
                en.description,
                zh.description,
                en.source,
                zh.source,
                en.note,
                zh.note,
                coalesce(en.version, zh.version),
                coalesce(en.status, zh.status),
                coalesce(en.algorithmic, zh.algorithmic)
            from smq_list_raw en
            left join smq_list_raw zh on zh.lang='zh' and zh.smq_code=en.smq_code
            where en.lang='en'
            union
            select zh.smq_code, en.smq_name, zh.smq_name, zh.smq_level, en.description,
                   zh.description, en.source, zh.source, en.note, zh.note,
                   zh.version, zh.status, zh.algorithmic
            from smq_list_raw zh
            left join smq_list_raw en on en.lang='en' and en.smq_code=zh.smq_code
            where zh.lang='zh' and en.smq_code is null
            """
        )
        con.execute(
            """
            insert or ignore into term_soc
            select 'SOC', soc_code, soc_code, 'Y' from hierarchy
            union select 'HLGT', hlgt_code, soc_code, primary_soc from hierarchy
            union select 'HLT', hlt_code, soc_code, primary_soc from hierarchy
            union select 'PT', pt_code, soc_code, primary_soc from hierarchy
            """
        )
        con.execute(
            """
            insert or ignore into term_soc
            select 'LLT', l.code, ts.soc_code, ts.primary_soc
            from terms l
            join term_soc ts on ts.level='PT' and ts.code=l.parent_code
            where l.level='LLT'
            """
        )

    def _load_synonyms(self, con: sqlite3.Connection) -> None:
        for lang, path in [("en", self.config.synonym_english), ("zh", self.config.synonym_chinese)]:
            if not path.exists():
                continue
            for parts in read_asc(path):
                if len(parts) < 2:
                    continue
                weight = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None
                con.execute(
                    "insert or ignore into synonyms values (?, ?, ?, ?)",
                    (lang, parts[0].strip(), parts[1].strip(), weight),
                )

    def _build_fts(self, con: sqlite3.Connection) -> None:
        con.execute(
            "create virtual table terms_fts using fts5(level, code, en_name, zh_name, tokenize='unicode61 remove_diacritics 2')"
        )
        con.execute(
            "insert into terms_fts(rowid, level, code, en_name, zh_name) "
            "select rowid, level, code, coalesce(en_name,''), coalesce(zh_name,'') from terms"
        )


class MeddraStore:
    def __init__(self, config: SourceConfig | None = None):
        self.config = config or default_source_config()
        MeddraIndexer(self.config).ensure_index()

    @lru_cache(maxsize=1)
    def all_terms(self) -> tuple[dict[str, Any], ...]:
        with self.connect() as con:
            rows = con.execute(
                """
                select t.*, group_concat(ts.soc_code) as soc_codes
                from terms t
                left join term_soc ts on ts.level=t.level and ts.code=t.code
                group by t.level, t.code
                order by case t.level when 'SOC' then 1 when 'HLGT' then 2 when 'HLT' then 3 when 'PT' then 4 when 'LLT' then 5 end,
                         coalesce(t.en_name, t.zh_name), t.code
                """
            ).fetchall()
            return tuple(dict(row) for row in rows)

    def connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.config.db_path)
        con.row_factory = sqlite3.Row
        return con

    def status(self) -> dict[str, Any]:
        with self.connect() as con:
            counts = con.execute("select * from source_counts order by lang, file_name").fetchall()
            term_counts = con.execute(
                "select level, count(*) as n from terms group by level order by case level when 'SOC' then 1 when 'HLGT' then 2 when 'HLT' then 3 when 'PT' then 4 when 'LLT' then 5 end"
            ).fetchall()
            smq_count = con.execute("select count(*) as n from smq").fetchone()["n"]
            return {
                "version": self.config.version,
                "available_languages": [
                    lang
                    for lang, path in [("en", self.config.english_dir), ("zh", self.config.chinese_dir)]
                    if path is not None
                ],
                "search_levels": ALL_SEARCH_LEVELS,
                "available_versions": [row.as_dict() for row in self.config.available_versions],
                "counts": [dict(row) for row in counts],
                "term_counts": [dict(row) for row in term_counts],
                "smq_count": smq_count,
            }

    def search(
        self,
        query: str,
        *,
        mode: str = "both",
        levels: list[str] | None = None,
        soc_codes: list[str] | None = None,
        include_synonyms: bool = True,
        ignore_diacritics: bool = True,
        include_non_current: bool = True,
        limit_per_group: int = 60,
    ) -> dict[str, Any]:
        query = (query or "").strip()
        norm_query = normalize_text(query, ignore_diacritics=ignore_diacritics)
        selected_levels = {x.upper() for x in levels or ["PT"]}
        selected_term_levels = selected_levels.intersection(LEVELS)
        selected_soc = {x for x in soc_codes or [] if x}
        categories: dict[str, list[dict[str, Any]]] = {key: [] for key in SEARCH_LABELS}
        seen: set[str] = set()

        def allowed(term: dict[str, Any]) -> bool:
            if term["level"] not in selected_levels:
                return False
            if not include_non_current and term["level"] == "LLT" and term.get("is_current") != "Y":
                return False
            if selected_soc:
                term_socs = set((term.get("soc_codes") or "").split(","))
                if not term_socs.intersection(selected_soc):
                    return False
            return True

        def fields_for(term: dict[str, Any]) -> list[tuple[str, str]]:
            fields: list[tuple[str, str]] = []
            if mode in ("en", "both"):
                fields.append(("英文名称", term.get("en_name") or ""))
            if mode in ("zh", "both"):
                fields.append(("中文名称", term.get("zh_name") or ""))
            return fields

        def add(category: str, term: dict[str, Any], field: str, score: float, reason: str) -> None:
            key = term["code"]
            if key in seen:
                return
            seen.add(key)
            categories[category].append(self._format_result(term, category, field, score, reason))

        terms = [term for term in self.all_terms() if term["level"] in selected_term_levels and allowed(term)]
        if not query:
            if "SMQ" in selected_levels:
                self._append_smq_search_results(categories, query, mode, limit_per_group)
            return self._search_response(query, categories, limit_per_group)

        for term in terms:
            for field, value in fields_for(term):
                norm_value = normalize_text(value, ignore_diacritics=ignore_diacritics)
                if norm_value == norm_query:
                    add("exact", term, field, 100, "术语文本与查询完全一致")
                    break

        query_key = token_key(query)
        if query_key:
            for term in terms:
                for field, value in fields_for(term):
                    value_key = token_key(value)
                    if value_key and value_key == query_key and normalize_text(value) != norm_query:
                        add("lexical", term, field, 94, "英文词序不同但词元集合一致")
                        break

        if include_synonyms:
            for expanded, source in self._synonym_expansions(query, mode, ignore_diacritics):
                expanded_norm = normalize_text(expanded, ignore_diacritics=ignore_diacritics)
                if not expanded_norm or expanded_norm == norm_query:
                    continue
                for term in terms:
                    for field, value in fields_for(term):
                        if expanded_norm in normalize_text(value, ignore_diacritics=ignore_diacritics):
                            add("synonym", term, field, 88, f"查询词通过同义词组“{source}”扩展为“{expanded}”")
                            break

        for term in terms:
            for field, value in fields_for(term):
                norm_value = normalize_text(value, ignore_diacritics=ignore_diacritics)
                if norm_query and norm_query in norm_value and norm_query != norm_value:
                    add("contains", term, field, 82, "术语文本包含查询字符串")
                    break

        for term in terms:
            for field, value in fields_for(term):
                norm_value = normalize_text(value, ignore_diacritics=ignore_diacritics)
                if norm_query and norm_query != norm_value and (
                    norm_value.startswith(norm_query) or norm_value.endswith(norm_query)
                ):
                    add("prefix_suffix", term, field, 80, "术语文本以查询开头或结尾")
                    break

        if re.fullmatch(r"\d{2,}", query):
            for term in terms:
                code = term["code"]
                if code == query:
                    add("code", term, "代码", 100, "代码完全匹配")
                elif code.startswith(query):
                    add("code", term, "代码", 86, "代码前缀匹配")
                elif query in code:
                    add("code", term, "代码", 74, "代码片段匹配")

        fuzzy_candidates: list[tuple[float, dict[str, Any], str, str]] = []
        if len(norm_query) >= 3:
            for term in terms:
                if term["code"] in seen:
                    continue
                for field, value in fields_for(term):
                    norm_value = normalize_text(value, ignore_diacritics=ignore_diacritics)
                    if not fuzzy_candidate(norm_query, norm_value):
                        continue
                    score = fuzzy_score(norm_query, norm_value)
                    if score >= fuzzy_threshold(norm_query):
                        fuzzy_candidates.append((score, term, field, value))
            fuzzy_candidates.sort(
                key=lambda item: (
                    -item[0],
                    numeric_code_key(item[1]["code"]),
                    level_rank(item[1]["level"]),
                    abs(len(normalize_text(item[3], ignore_diacritics=ignore_diacritics)) - len(norm_query)),
                )
            )
            for score, term, field, value in fuzzy_candidates[:limit_per_group]:
                add("fuzzy", term, field, score, f"拼写或近似文本候选；候选字段为“{field}”")

        if "SMQ" in selected_levels:
            self._append_smq_search_results(categories, query, mode, limit_per_group)

        return self._search_response(query, categories, limit_per_group)

    def advanced_search(self, payload: dict[str, Any]) -> dict[str, Any]:
        conditions = payload.get("conditions") or []
        boolean = (payload.get("boolean") or "AND").upper()
        mode = payload.get("mode") or "both"
        levels = payload.get("levels") or ["PT"]
        terms = [term for term in self.all_terms() if term["level"] in set(levels).intersection(LEVELS)]

        def match_condition(term: dict[str, Any], cond: dict[str, str]) -> bool:
            value = normalize_text(cond.get("value", ""))
            operator = cond.get("operator", "contains")
            if not value:
                return True
            fields = []
            if mode in ("en", "both"):
                fields.append(normalize_text(term.get("en_name") or ""))
            if mode in ("zh", "both"):
                fields.append(normalize_text(term.get("zh_name") or ""))
            for field in fields:
                if operator == "exact" and field == value:
                    return True
                if operator == "begins" and field.startswith(value):
                    return True
                if operator == "ends" and field.endswith(value):
                    return True
                if operator == "contains" and value in field:
                    return True
            return False

        results: list[dict[str, Any]] = []
        for term in terms:
            checks = [match_condition(term, cond) for cond in conditions[:2]]
            if not checks:
                continue
            if boolean == "OR":
                ok = any(checks)
            elif boolean == "NOT":
                ok = checks[0] and not (checks[1] if len(checks) > 1 else False)
            else:
                ok = all(checks)
            if ok:
                results.append(self._format_result(term, "advanced", "高级搜索", 100, "符合高级搜索条件"))
            if len(results) >= 200:
                break
        return {"query": payload, "results": results, "count": len(results)}

    def code_lookup(self, code: str) -> dict[str, Any]:
        with self.connect() as con:
            rows = con.execute(
                """
                select * from terms
                where code=?
                order by case level when 'SOC' then 1 when 'HLGT' then 2 when 'HLT' then 3 when 'PT' then 4 when 'LLT' then 5 end
                """,
                (code,),
            ).fetchall()
        rows = dedupe_same_code_rows(rows)
        return {"code": code, "matches": [self.details(row["level"], code) for row in rows]}

    def details(self, level: str, code: str) -> dict[str, Any]:
        level = level.upper()
        if level == "SMQ":
            data = self.smq_details(code)
            if not data.get("found"):
                return {"level": level, "code": code, "found": False}
            return {
                "found": True,
                "level": "SMQ",
                "code": code,
                "level_label": LEVEL_LABELS["SMQ"],
                "smq": data["smq"],
                "children": data["children"],
                "parents": data.get("parents", []),
                "content": data["content"],
                "relationships": data.get("relationships", {}),
            }
        with self.connect() as con:
            term = con.execute("select * from terms where level=? and code=?", (level, code)).fetchone()
            if term is None:
                return {"level": level, "code": code, "found": False}
            rows = self._hierarchy_rows(con, level, code)
            smqs = self._smq_memberships(con, level, code, term["parent_code"])
            children_count = self._children_count(con, level, code)
            relationships = self._term_relationships(con, level, code, term, rows)
            return {
                "found": True,
                "term": dict(term),
                "level_label": LEVEL_LABELS.get(level, level),
                "hierarchies": [dict(row) for row in rows],
                "smq_memberships": smqs,
                "children_count": children_count,
                "relationships": relationships,
            }

    def tree(self, view: str, level: str | None = None, code: str | None = None, mode: str = "both") -> dict[str, Any]:
        if view == "smq":
            return self._smq_tree(code, mode)
        return self._soc_tree(level, code, mode)

    def smq_search(self, query: str, mode: str = "both") -> dict[str, Any]:
        q = normalize_text(query)
        with self.connect() as con:
            rows = con.execute("select * from smq order by cast(smq_code as integer)").fetchall()
            code_hits: set[str] = set()
            if query.strip().isdigit():
                term_rows = con.execute(
                    "select distinct smq_code from smq_content where term_code like ? or smq_code like ?",
                    (f"{query.strip()}%", f"{query.strip()}%"),
                ).fetchall()
                code_hits = {row["smq_code"] for row in term_rows}
        results = []
        for row in rows:
            fields = []
            if mode in ("en", "both"):
                fields.append(row["en_name"] or "")
            if mode in ("zh", "both"):
                fields.append(row["zh_name"] or "")
            if (
                not q
                or any(q in normalize_text(field) for field in fields)
                or row["smq_code"].startswith(query)
                or row["smq_code"] in code_hits
            ):
                results.append(self._format_smq(row))
        return {"query": query, "results": results[:200], "count": len(results)}

    def synonyms(self, lang: str = "en", limit: int = 500) -> dict[str, Any]:
        lang = "zh" if lang == "zh" else "en"
        with self.connect() as con:
            rows = con.execute(
                "select * from synonyms where lang=? order by synonym_group, phrase limit ?",
                (lang, max(1, min(limit, 2000))),
            ).fetchall()
            count = con.execute("select count(*) as n from synonyms where lang=?", (lang,)).fetchone()["n"]
        return {"lang": lang, "count": count, "results": [dict(row) for row in rows]}

    def smq_details(self, smq_code: str, mode: str = "both") -> dict[str, Any]:
        with self.connect() as con:
            smq = con.execute("select * from smq where smq_code=?", (smq_code,)).fetchone()
            if smq is None:
                return {"found": False, "smq_code": smq_code}
            content = con.execute(
                """
                select sc.*, t.en_name, t.zh_name, t.level
                from smq_content sc
                left join terms t on t.code=sc.term_code and
                    t.level = case sc.term_level when '4' then 'PT' when '5' then 'LLT' else t.level end
                where sc.smq_code=?
                order by cast(sc.scope as integer) desc, coalesce(t.en_name, t.zh_name, sc.term_code)
                """,
                (smq_code,),
            ).fetchall()
            children = con.execute(
                "select s.* from smq_content sc join smq s on s.smq_code=sc.term_code where sc.smq_code=? order by cast(s.smq_code as integer), s.smq_code",
                (smq_code,),
            ).fetchall()
            parents = con.execute(
                """
                select distinct s.*
                from smq_content sc
                join smq s on s.smq_code=sc.smq_code
                where sc.term_code=?
                order by cast(s.smq_code as integer), s.smq_code
                """,
                (smq_code,),
            ).fetchall()
            child_terms = [self._format_smq_content(row) for row in content]
            child_smqs = [self._format_smq(row, mode) for row in children]
            parent_smqs = [self._format_smq(row, mode) for row in parents]
        return {
            "found": True,
            "smq": self._format_smq(smq),
            "children": child_smqs,
            "parents": parent_smqs,
            "content": child_terms,
            "relationships": {
                "parents": parent_smqs,
                "children": child_smqs,
                "content": child_terms,
                "content_count": len(child_terms),
            },
        }

    def hierarchy_analysis(self, code: str, level: str = "PT") -> dict[str, Any]:
        detail = self.details(level, code)
        return {
            "code": code,
            "level": level,
            "hierarchies": detail.get("hierarchies", []),
            "count": len(detail.get("hierarchies", [])),
        }

    def smq_analysis(self, code: str, level: str = "PT") -> dict[str, Any]:
        detail = self.details(level, code)
        return {
            "code": code,
            "level": level,
            "smq_memberships": detail.get("smq_memberships", []),
            "count": len(detail.get("smq_memberships", [])),
        }

    def export_csv(self, rows: Iterable[dict[str, Any]]) -> str:
        rows = list(rows)
        output = io.StringIO()
        if not rows:
            return ""
        fieldnames = list(rows[0].keys())
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
        return output.getvalue()

    def _search_response(
        self, query: str, categories: dict[str, list[dict[str, Any]]], limit_per_group: int = 60
    ) -> dict[str, Any]:
        groups = [
            {
                "category": key,
                "label": SEARCH_LABELS[key],
                "results": sorted(value, key=search_result_sort_key)[:limit_per_group],
                "count": min(len(value), limit_per_group),
            }
            for key, value in categories.items()
            if value
        ]
        return {"query": query, "groups": groups, "count": sum(g["count"] for g in groups)}

    def _append_smq_search_results(
        self, categories: dict[str, list[dict[str, Any]]], query: str, mode: str, limit: int
    ) -> None:
        rows = self.smq_search(query, mode).get("results", [])
        for row in rows[:limit]:
            categories["smq"].append(
                {
                    "level": "SMQ",
                    "level_label": LEVEL_LABELS["SMQ"],
                    "code": row["smq_code"],
                    "en_name": row.get("en_name") or "",
                    "zh_name": row.get("zh_name") or "",
                    "is_current": row.get("status") or "",
                    "category": "smq",
                    "category_label": SEARCH_LABELS["smq"],
                    "matched_field": "SMQ名称/代码/内容术语",
                    "score": 90,
                    "reason": "SMQ名称、SMQ代码或SMQ内容术语代码匹配",
                }
            )

    def _format_result(
        self, term: dict[str, Any], category: str, field: str, score: float, reason: str
    ) -> dict[str, Any]:
        return {
            "level": term["level"],
            "level_label": LEVEL_LABELS.get(term["level"], term["level"]),
            "code": term["code"],
            "en_name": term.get("en_name") or "",
            "zh_name": term.get("zh_name") or "",
            "is_current": term.get("is_current") or "",
            "category": category,
            "category_label": SEARCH_LABELS.get(category, category),
            "matched_field": field,
            "score": round(float(score), 1),
            "reason": reason,
        }

    def _synonym_expansions(self, query: str, mode: str, ignore_diacritics: bool) -> list[tuple[str, str]]:
        langs = ["en", "zh"] if mode == "both" else [mode]
        norm_query = normalize_text(query, ignore_diacritics=ignore_diacritics)
        expansions: list[tuple[str, str]] = []
        with self.connect() as con:
            for lang in langs:
                rows = con.execute("select * from synonyms where lang=?", (lang,)).fetchall()
                matching_groups = {
                    row["synonym_group"]
                    for row in rows
                    if normalize_text(row["phrase"], ignore_diacritics=ignore_diacritics) in norm_query
                }
                for row in rows:
                    if row["synonym_group"] in matching_groups:
                        expansions.append((row["phrase"], row["synonym_group"]))
        return expansions

    def _term_relationships(
        self,
        con: sqlite3.Connection,
        level: str,
        code: str,
        term: sqlite3.Row,
        hierarchy_rows: list[sqlite3.Row],
    ) -> dict[str, Any]:
        parents = self._relation_parents(con, level, code, term["parent_code"])
        children = self._relation_children(con, level, code)
        paths = [dict(row) for row in hierarchy_rows]
        return {
            "parents": parents,
            "children": children,
            "children_count": len(children),
            "hierarchy_paths": paths,
            "primary_paths": [row for row in paths if row.get("primary_soc") == "Y"],
            "smq_memberships": self._smq_memberships(con, level, code, term["parent_code"]),
        }

    def _relation_parents(
        self, con: sqlite3.Connection, level: str, code: str, parent_code: str | None
    ) -> list[dict[str, Any]]:
        if level == "LLT" and parent_code:
            row = con.execute("select * from terms where level='PT' and code=?", (parent_code,)).fetchone()
            return [self._format_relation_term(con, row)] if row else []
        relation = {"PT": ("HLT_PT", "HLT"), "HLT": ("HLGT_HLT", "HLGT"), "HLGT": ("SOC_HLGT", "SOC")}.get(level)
        if not relation:
            return []
        relation_name, parent_level = relation
        rows = con.execute(
            """
            select distinct t.*
            from relations r
            join terms t on t.level=? and t.code=r.parent_code
            where r.relation=? and r.child_code=?
            order by cast(t.code as integer), t.code
            """,
            (parent_level, relation_name, code),
        ).fetchall()
        return [self._format_relation_term(con, row) for row in rows]

    def _relation_children(self, con: sqlite3.Connection, level: str, code: str) -> list[dict[str, Any]]:
        relation = {
            "SOC": ("SOC_HLGT", "HLGT"),
            "HLGT": ("HLGT_HLT", "HLT"),
            "HLT": ("HLT_PT", "PT"),
            "PT": ("PT_LLT", "LLT"),
        }.get(level)
        if not relation:
            return []
        relation_name, child_level = relation
        rows = con.execute(
            """
            select distinct t.*
            from relations r
            join terms t on t.level=? and t.code=r.child_code
            where r.relation=? and r.parent_code=?
            order by cast(t.code as integer), t.code
            limit 500
            """,
            (child_level, relation_name, code),
        ).fetchall()
        return [self._format_relation_term(con, row) for row in rows]

    def _format_relation_term(self, con: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "level": row["level"],
            "level_label": LEVEL_LABELS.get(row["level"], row["level"]),
            "code": row["code"],
            "en_name": row["en_name"] or "",
            "zh_name": row["zh_name"] or "",
            "display_name": display_name(row["en_name"], row["zh_name"], "both"),
            "parent_code": row["parent_code"] or "",
            "is_current": row["is_current"] or "",
            "children_count": self._children_count(con, row["level"], row["code"]),
        }

    def _preferred_hierarchy_lang(self, con: sqlite3.Connection) -> str | None:
        row = con.execute("select lang from hierarchy where lang='en' limit 1").fetchone()
        if row:
            return "en"
        row = con.execute("select lang from hierarchy limit 1").fetchone()
        return row["lang"] if row else None

    def _hierarchy_rows(self, con: sqlite3.Connection, level: str, code: str) -> list[sqlite3.Row]:
        col = {
            "PT": "pt_code",
            "HLT": "hlt_code",
            "HLGT": "hlgt_code",
            "SOC": "soc_code",
        }.get(level)
        if level == "LLT":
            parent = con.execute("select parent_code from terms where level='LLT' and code=?", (code,)).fetchone()
            if not parent:
                return []
            col = "pt_code"
            code = parent["parent_code"]
        if not col:
            return []
        base_lang = self._preferred_hierarchy_lang(con)
        if not base_lang:
            return []
        return con.execute(
            f"""
            select base.pt_code, base.hlt_code, base.hlgt_code, base.soc_code,
                   en.pt_name as en_pt_name, zh.pt_name as zh_pt_name,
                   en.hlt_name as en_hlt_name, zh.hlt_name as zh_hlt_name,
                   en.hlgt_name as en_hlgt_name, zh.hlgt_name as zh_hlgt_name,
                   en.soc_name as en_soc_name, zh.soc_name as zh_soc_name,
                   base.primary_soc
            from hierarchy base
            left join hierarchy en
              on en.lang='en' and en.pt_code=base.pt_code and en.hlt_code=base.hlt_code
             and en.hlgt_code=base.hlgt_code and en.soc_code=base.soc_code
            left join hierarchy zh
              on zh.lang='zh' and zh.pt_code=base.pt_code and zh.hlt_code=base.hlt_code
             and zh.hlgt_code=base.hlgt_code and zh.soc_code=base.soc_code
            where base.lang=? and base.{col}=?
            order by base.primary_soc desc, coalesce(zh.soc_name, en.soc_name, base.soc_name)
            """,
            (base_lang, code),
        ).fetchall()

    def _smq_memberships(
        self, con: sqlite3.Connection, level: str, code: str, parent_code: str | None
    ) -> list[dict[str, Any]]:
        codes = [code]
        if level == "LLT" and parent_code:
            codes.append(parent_code)
        placeholders = ",".join("?" for _ in codes)
        rows = con.execute(
            f"""
            select sc.*, s.en_name, s.zh_name
            from smq_content sc
            join smq s on s.smq_code=sc.smq_code
            where sc.term_code in ({placeholders})
            order by cast(s.smq_code as integer), s.smq_code
            """,
            codes,
        ).fetchall()
        return [self._format_smq_membership(row) for row in rows]

    def _children_count(self, con: sqlite3.Connection, level: str, code: str) -> int:
        relation = {"SOC": "SOC_HLGT", "HLGT": "HLGT_HLT", "HLT": "HLT_PT", "PT": "PT_LLT"}.get(level)
        if not relation:
            return 0
        return con.execute(
            "select count(distinct child_code) as n from relations where relation=? and parent_code=?",
            (relation, code),
        ).fetchone()["n"]

    def _soc_tree(self, level: str | None, code: str | None, mode: str) -> dict[str, Any]:
        with self.connect() as con:
            if not level:
                rows = con.execute(
                    """
                    select t.* from terms t
                    left join (
                      select soc_code, min(sort_order) as sort_order
                      from soc_order
                      group by soc_code
                    ) o on o.soc_code=t.code
                    where t.level='SOC'
                    order by cast(t.code as integer), t.code
                    """
                ).fetchall()
                return {"nodes": [self._format_node(row, "SOC", mode, con) for row in rows]}
            relation = {"SOC": "SOC_HLGT", "HLGT": "HLGT_HLT", "HLT": "HLT_PT", "PT": "PT_LLT"}.get(level.upper())
            child_level = {"SOC": "HLGT", "HLGT": "HLT", "HLT": "PT", "PT": "LLT"}.get(level.upper())
            if not relation or not child_level or not code:
                return {"nodes": []}
            rows = con.execute(
                """
                select distinct t.* from relations r
                join terms t on t.level=? and t.code=r.child_code
                where r.relation=? and r.parent_code=?
                order by cast(t.code as integer), t.code
                """,
                (child_level, relation, code),
            ).fetchall()
            return {"nodes": [self._format_node(row, child_level, mode, con) for row in rows]}

    def _smq_tree(self, code: str | None, mode: str) -> dict[str, Any]:
        with self.connect() as con:
            if not code:
                rows = con.execute(
                    "select * from smq where smq_level='1' order by cast(smq_code as integer), smq_code"
                ).fetchall()
            else:
                rows = con.execute(
                    "select s.* from smq_content sc join smq s on s.smq_code=sc.term_code where sc.smq_code=? order by cast(s.smq_code as integer), s.smq_code",
                    (code,),
                ).fetchall()
            return {"nodes": [self._format_smq(row, mode) for row in rows]}

    def _format_node(
        self, row: sqlite3.Row, level: str, mode: str, con: sqlite3.Connection
    ) -> dict[str, Any]:
        return {
            "level": level,
            "level_label": LEVEL_LABELS[level],
            "code": row["code"],
            "en_name": row["en_name"] or "",
            "zh_name": row["zh_name"] or "",
            "display_name": display_name(row["en_name"], row["zh_name"], mode),
            "has_children": self._children_count(con, level, row["code"]) > 0,
            "is_current": row["is_current"],
        }

    def _format_smq(self, row: sqlite3.Row, mode: str = "both") -> dict[str, Any]:
        return {
            "smq_code": row["smq_code"],
            "code": row["smq_code"],
            "level": "SMQ",
            "smq_level": row["smq_level"],
            "en_name": row["en_name"] or "",
            "zh_name": row["zh_name"] or "",
            "display_name": display_name(row["en_name"], row["zh_name"], mode),
            "status": row["status"],
            "version": row["version"],
            "algorithmic": row["algorithmic"],
            "en_description": row["en_description"] or "",
            "zh_description": row["zh_description"] or "",
            "en_note": row["en_note"] or "",
            "zh_note": row["zh_note"] or "",
        }

    def _format_smq_content(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "smq_code": row["smq_code"],
            "term_code": row["term_code"],
            "term_level": {"4": "PT", "5": "LLT"}.get(row["term_level"], row["term_level"]),
            "scope": row["scope"],
            "scope_label": SCOPE_LABELS.get(row["scope"], row["scope"]),
            "status": row["status"],
            "status_label": "有效" if row["status"] == "A" else "非活动",
            "category": row["category"],
            "en_name": row["en_name"] or "",
            "zh_name": row["zh_name"] or "",
        }

    def _format_smq_membership(self, row: sqlite3.Row) -> dict[str, Any]:
        data = self._format_smq_content(row)
        data["smq_en_name"] = row["en_name"] or ""
        data["smq_zh_name"] = row["zh_name"] or ""
        return data


def display_name(en_name: str | None, zh_name: str | None, mode: str) -> str:
    en_name = en_name or ""
    zh_name = zh_name or ""
    if mode == "en":
        return en_name or zh_name
    if mode == "zh":
        return zh_name or en_name
    if en_name and zh_name and en_name != zh_name:
        return f"{zh_name} / {en_name}"
    return zh_name or en_name


def dedupe_same_code_rows(rows: list[sqlite3.Row]) -> list[sqlite3.Row]:
    has_pt = any(row["level"] == "PT" for row in rows)
    if not has_pt:
        return rows
    return [row for row in rows if row["level"] != "LLT"]


def level_rank(level: str) -> int:
    return {"SOC": 1, "HLGT": 2, "HLT": 3, "PT": 4, "LLT": 5}.get(level, 99)


def numeric_code_key(code: str | int | None) -> tuple[int, int | str]:
    value = str(code or "")
    if value.isdigit():
        return (0, int(value))
    return (1, value)


def search_result_sort_key(row: dict[str, Any]) -> tuple[float, tuple[int, int | str], int]:
    return (-float(row.get("score") or 0), numeric_code_key(row.get("code")), level_rank(str(row.get("level") or "")))


def fuzzy_threshold(query: str) -> float:
    if len(query) <= 4:
        return 82.0
    if len(query) <= 8:
        return 76.0
    return 70.0


def fuzzy_score(query: str, value: str) -> float:
    if not query or not value:
        return 0.0
    base = SequenceMatcher(None, query, value).ratio() * 100
    if len(query) <= len(value):
        partial = max(
            SequenceMatcher(None, query, value[i : i + len(query)]).ratio() * 100
            for i in range(0, len(value) - len(query) + 1)
        )
    else:
        partial = 0.0
    token_bonus = 0.0
    q_tokens = set(token_key(query).split())
    v_tokens = set(token_key(value).split())
    if q_tokens and v_tokens and q_tokens.intersection(v_tokens):
        token_bonus = 8.0
    return min(100.0, max(base, partial) + token_bonus)


def fuzzy_candidate(query: str, value: str) -> bool:
    if not query or not value:
        return False
    if query in value or value in query:
        return True
    if abs(len(query) - len(value)) <= 4 and query[:1] == value[:1]:
        return True
    query_ascii = bool(re.search(r"[a-z0-9]", query))
    if query_ascii:
        q_tokens = [t for t in re.split(r"[^a-z0-9]+", query) if len(t) >= 3]
        v_tokens = [t for t in re.split(r"[^a-z0-9]+", value) if len(t) >= 3]
        if any(q[:3] in v or v[:3] in q for q in q_tokens for v in v_tokens):
            return True
        q_grams = {query[i : i + 3] for i in range(max(0, len(query) - 2))}
        v_grams = {value[i : i + 3] for i in range(max(0, len(value) - 2))}
        return bool(q_grams.intersection(v_grams))
    shared = set(query).intersection(set(value))
    return len(shared) >= max(1, min(3, len(query) // 2))


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)
