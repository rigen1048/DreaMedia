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
from Admin.backup import _find_pg_dump, run_backup
from Config.Hardcoded.limits import PG_DUMP_CANDIDATES
from Database.db import dsn
from Utility.logs import log

# Global restore gate (2026 review: in-place restore with live writers is a
# known-acknowledged hazard — now it actually pauses them). Managers check
# restore_in_progress() each pass; the API middleware 503s mutations.
_restore_active = False


def restore_in_progress() -> bool:
    return _restore_active

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

    # 1. Pre-restore snapshot — the tested rollback path (2026 review).
    snapshot = await run_backup()
    if isinstance(snapshot, Failure):
        return Failure(f"pre-restore snapshot failed, restore refused: {snapshot.failure()}")
    log.warning("pre-restore snapshot: %s", snapshot.unwrap())

    # 2. Pause workers + writers for the restore window.
    global _restore_active
    _restore_active = True
    log.warning("RESTORE started: %s (destructive; workers paused)", filename)
    try:
        proc = await asyncio.create_subprocess_exec(
            pg_restore, "-d", dsn(), "--clean", "--if-exists", str(target),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            # 3. Roll back from the snapshot so the db is never left partial.
            log.error("RESTORE failed: %s — rolling back from snapshot", stderr.decode()[-300:])
            rb = await asyncio.create_subprocess_exec(
                pg_restore, "-d", dsn(), "--clean", "--if-exists", snapshot.unwrap(),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            _, rb_err = await rb.communicate()
            if rb.returncode == 0:
                log.warning("ROLLBACK complete: pre-restore state recovered")
                return Failure(f"pg_restore failed (rollback ok): {stderr.decode()[-300:]}")
            log.critical("ROLLBACK FAILED: %s", rb_err.decode()[-300:])
            return Failure(f"pg_restore failed AND rollback failed: {stderr.decode()[-200:]}")
    finally:
        _restore_active = False
    log.warning("RESTORE complete: %s", filename)
    return Success(filename)
