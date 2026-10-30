"""Postgres backups (D13/D26).

- Dump via pg_dump → timestamped file in the admin-chosen directory.
- Retention: keep the N latest, floor-enforced (MIN_BACKUPS_KEPT, D2).
- Dumps are ciphertext by construction (D8): pg_dump reads the DB, and
  the DB only ever holds encrypted user content. Documented so nobody
  "fixes" it by dumping through the decrypt layer.
"""
from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path

from returns.result import Failure, Result, Success

from Admin import settings
from Config.Hardcoded.limits import MIN_BACKUPS_KEPT, PG_DUMP_CANDIDATES
from Database.db import dsn
from Utility.logs import log


def _find_pg_dump() -> str | None:
    for candidate in PG_DUMP_CANDIDATES:
        found = shutil.which(candidate) or (candidate if Path(candidate).exists() else None)
        if found:
            return found
    return None


async def run_backup() -> Result[str, str]:
    pg_dump = _find_pg_dump()
    if not pg_dump:
        return Failure("pg_dump not found (looked in PATH + PG_DUMP_CANDIDATES)")

    backup_dir = Path(str(await settings.get_typed("backup_dir") or "./backups"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    # Microseconds: same-second backups must not overwrite each other.
    out = backup_dir / f"dreamedia-{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1e6) % 10**6:06d}.dump"

    # Extracted userland binaries (this dev host) need their lib dir;
    # system/d/docker pg_dump ignores the empty fallback harmlessly.
    import os

    env = dict(os.environ)
    # .../usr/lib/postgresql/17/bin/pg_dump → libpq lives in .../usr/lib/x86_64-linux-gnu
    lib_dir = Path(pg_dump).parents[3] / "x86_64-linux-gnu"
    if lib_dir.is_dir():
        env["LD_LIBRARY_PATH"] = f"{lib_dir}:{env.get('LD_LIBRARY_PATH', '')}"

    proc = await asyncio.create_subprocess_exec(
        pg_dump, dsn(), "-Fc", "-f", str(out),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        return Failure(f"pg_dump failed: {stderr.decode().strip()}")

    await prune_old_backups(backup_dir)
    log.info("backup written: %s", out)
    return Success(str(out))


async def prune_old_backups(backup_dir: Path) -> int:
    """Delete all but the newest N dumps. N is floored at MIN_BACKUPS_KEPT."""
    keep = await settings.get_typed("backup_keep_latest") or MIN_BACKUPS_KEPT
    keep = max(int(keep), MIN_BACKUPS_KEPT)  # belt and braces, floor lives in code too
    dumps = sorted(backup_dir.glob("dreamedia-*.dump"), key=lambda p: p.stat().st_mtime)
    removed = 0
    for old in dumps[:-keep]:
        old.unlink()
        removed += 1
    if removed:
        log.info("backup retention: pruned %s old dump(s), keeping %s", removed, keep)
    return removed
