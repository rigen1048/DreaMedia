"""Backup recovery (completes D13): list + restore pg_dump files.

Design:
- Restore is destructive — admin-only, explicit file name required,
  path validated to live inside the configured backup_dir (no traversal).
- pg_restore --clean --if-exists: drops and recreates objects in place.
  On a home-server docker app (D6) this is a maintenance-window
  operation; managers keep running but their writes during restore are
  not guaranteed (documented, not hidden).
- After restore the vault is untouched: user passwords didn't change,
  so derived keys still match the (older) ciphertext.
"""
from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any, Dict, List

from returns.result import Failure, Result, Success

from Admin import settings
from Admin.backup import _find_pg_dump
from Config.Hardcoded.limits import PG_DUMP_CANDIDATES
from Database.db import dsn
from Utility.logs import log

_DUMP_RE = re.compile(r"^dreamedia-\d{8}-\d{6}-\d{6}\.dump$")


async def list_backups() -> List[Dict[str, Any]]:
    backup_dir = Path(str(await settings.get_typed("backup_dir") or "./backups"))
    if not backup_dir.is_dir():
        return []
    dumps = sorted(
        backup_dir.glob("dreamedia-*.dump"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    return [
        {"file": p.name, "size": p.stat().st_size, "mtime": int(p.stat().st_mtime)}
        for p in dumps
    ]


def _pg_restore_bin() -> str | None:
    for candidate in PG_DUMP_CANDIDATES:
        path = candidate.replace("pg_dump", "pg_restore")
        found = None
        import shutil

        found = shutil.which(path) or (path if Path(path).exists() else None)
        if found:
            return found
    return None


async def restore_backup(filename: str) -> Result[str, str]:
    """Restore a named dump into the live database. DESTRUCTIVE."""
    if not _DUMP_RE.match(filename or ""):
        return Failure("invalid backup filename")
    backup_dir = Path(str(await settings.get_typed("backup_dir") or "./backups")).resolve()
    target = (backup_dir / filename).resolve()
    if backup_dir not in target.parents:
        return Failure("path escapes backup directory")
    if not target.is_file():
        return Failure("backup file not found")

    pg_restore = _pg_restore_bin()
    if not pg_restore:
        return Failure("pg_restore not found")

    env = dict(os.environ)
    lib_dir = Path(pg_restore).parents[3] / "x86_64-linux-gnu"
    if lib_dir.is_dir():
        env["LD_LIBRARY_PATH"] = f"{lib_dir}:{env.get('LD_LIBRARY_PATH', '')}"

    log.warning("RESTORE started: %s (destructive)", filename)
    proc = await asyncio.create_subprocess_exec(
        pg_restore, "-d", dsn(), "--clean", "--if-exists", str(target),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        log.error("RESTORE failed: %s", stderr.decode()[-500:])
        return Failure(f"pg_restore failed: {stderr.decode()[-400:]}")
    log.warning("RESTORE complete: %s", filename)
    return Success(filename)
