"""Reproducibility: code version, code digest and recipe hash recorded in every manifest."""

from __future__ import annotations

import functools
import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from webflix_recs import __version__
from webflix_recs.schemas import schema_dir

PACKAGE_DIR = Path(__file__).resolve().parent


@functools.cache
def code_digest() -> str:
    """SHA-256 over the package's Python sources and the schema files (path and content)."""
    digest = hashlib.sha256()
    files = sorted(PACKAGE_DIR.rglob("*.py")) + sorted(schema_dir().glob("*.json"))
    for path in files:
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


@functools.cache
def git_version() -> dict[str, Any]:
    """The repository commit and whether services/recs has uncommitted changes (read-only git).
    In the job image there is no repository: `WEBFLIX_RECS_GIT_COMMIT` is set at build time."""
    commit = os.environ.get("WEBFLIX_RECS_GIT_COMMIT")
    if commit:
        return {"commit": commit, "dirty": os.environ.get("WEBFLIX_RECS_GIT_DIRTY") == "1"}
    try:
        root = PACKAGE_DIR.parents[1]
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        status = subprocess.run(
            ["git", "status", "--porcelain", "--", "."],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        return {"commit": head.stdout.strip(), "dirty": bool(status.stdout.strip())}
    except (OSError, subprocess.SubprocessError):
        return {"commit": None, "dirty": None}


def code_version() -> dict[str, Any]:
    return {"package": __version__, "codeDigest": code_digest(), **git_version()}


def canonical(document: Any) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), default=str)


def recipe_hash(params: dict[str, Any]) -> str:
    """Identity of what was trained, independent of data: code digest + parameters. A published
    run must carry the recipe hash of an evaluation that passed the gate."""
    return hashlib.sha256((code_digest() + canonical(params)).encode()).hexdigest()[:16]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
