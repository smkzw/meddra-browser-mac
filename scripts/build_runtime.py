"""Assemble redistributable CPython and runtime wheels without using host wheels."""

from __future__ import annotations

import errno
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
RELEASE = "20261110"
PYTHON = "3.13.18"
TARGETS = {
    "macos-arm64": (
        "aarch64-apple-darwin",
        "7a2384641584ab9984221fcb0fc9265df465922af71be71410529e2a9c3f0540",
    ),
    "macos-x86_64": (
        "x86_64-apple-darwin",
        "d27d59a722db9f69926eb6d9564071247221f45a04da920ea7f3001c97e32f9b",
    ),
    "windows-x86_64": (
        "x86_64-pc-windows-msvc",
        "2e0fed09d48989f64c9305da9ff2d37a41c0d13ab2aa6283405b2b620dfbf805",
    ),
}
REQUIREMENTS = ROOT / "scripts" / "runtime-requirements.txt"
CACHE = ROOT / "build" / "runtime"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def assemble(target: str, destination: Path) -> None:
    triple, expected = TARGETS[target]
    archive_name = f"cpython-{PYTHON}+{RELEASE}-{triple}-install_only_stripped.tar.gz"
    archive = CACHE / archive_name
    if not archive.exists() or digest(archive) != expected:
        with tempfile.TemporaryDirectory(dir=CACHE) as directory:
            download = Path(directory) / archive_name
            url = f"https://github.com/astral-sh/python-build-standalone/releases/download/{RELEASE}/{archive_name}"
            subprocess.run(
                ["curl", "--fail", "--location", "--retry", "3", "--retry-all-errors", "--connect-timeout", "15",
                 "--max-time", "120", "--silent", "--show-error", "-o", str(download), url],
                check=True,
            )
            if digest(download) != expected:
                raise RuntimeError(f"CPython archive checksum mismatch: {archive_name}")
            download.replace(archive)

    # Copy only regular files for the shared ZIP so Explorer can extract it
    # without creating symlinks. Relative interpreter aliases are unnecessary.
    with tempfile.TemporaryDirectory(dir=CACHE) as directory:
        unpacked = Path(directory)
        with tarfile.open(archive) as bundle:
            bundle.extractall(unpacked, filter="data")
        runtime = unpacked / "python"
        windows = target.startswith("windows")
        site = runtime / ("Lib/site-packages" if windows else "lib/python3.13/site-packages")
        subprocess.run(
            ["uv", "pip", "install", "--no-config", "--python-version", PYTHON, "--python-platform", triple,
             "--only-binary", ":all:", "--target", str(site), "-r", str(REQUIREMENTS)],
            check=True,
        )
        # Package entry point is our launcher. Generated command wrappers embed
        # the build interpreter path. Keep library modules and their licenses.
        for name in ("bin", "Scripts"):
            shutil.rmtree(site / name, ignore_errors=True)
        for path in runtime.rglob("__pycache__"):
            shutil.rmtree(path)
        for path in runtime.rglob("*.pyc"):
            path.unlink()
        for path in runtime.rglob("direct_url.json"):
            path.unlink()
        for path in runtime.rglob("RECORD"):
            path.write_text(
                "".join(line for line in path.read_text(encoding="utf-8").splitlines(keepends=True)
                        if ".pyc," not in line and not line.startswith("../")),
                encoding="utf-8",
            )
        if not windows:
            for alias in ("python", "python3"):
                (runtime / "bin" / alias).unlink(missing_ok=True)
        for path in runtime.rglob("*"):
            if path.is_symlink():
                source = path.resolve(strict=True)
                path.unlink()
                shutil.copy2(source, path)
        shutil.copytree(runtime, destination)


def main() -> None:
    if sys.version_info < (3, 12):
        raise SystemExit("Packaging requires Python 3.12+ and uv.")
    output = Path(sys.argv[1])
    CACHE.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    for target in sys.argv[2:]:
        key = f"{target}-{digest(REQUIREMENTS)[:16]}-{digest(Path(__file__))[:16]}"
        cached = CACHE / key
        if not cached.exists():
            with tempfile.TemporaryDirectory(dir=CACHE) as directory:
                staged = Path(directory) / target
                assemble(target, staged)
                try:
                    staged.rename(cached)
                except OSError as exc:
                    # Another build may have published the same immutable cache.
                    if exc.errno not in {errno.EEXIST, errno.ENOTEMPTY} or not cached.is_dir():
                        raise
        shutil.copytree(cached, output / target)


if __name__ == "__main__":
    main()
