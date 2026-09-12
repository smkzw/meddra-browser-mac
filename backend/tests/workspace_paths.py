from __future__ import annotations

from pathlib import Path


def workspace_dictionary_root() -> Path:
    """Locate the authorized MedDRA workspace even when tests run from a worktree."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "MedDRA_29_0_Chinese").is_dir() or (parent / "MedDRA_29_0_English").is_dir():
            return parent
    raise RuntimeError("authorized MedDRA workspace dictionary root was not found")
