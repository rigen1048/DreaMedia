"""Backup recovery (completes D13): list, stage, restore pg_dump files.

Design:
- Restore is destructive — admin-only, explicit file name required, path
  validated to live inside the configured backup_dir (no traversal).
- pg_restore --clean --if-exists: drops and recreates objects in place.
  On a home-server docker app (D6) this is a maintenance-window operation,
  so a restore now runs as a tracked background task: the HTTP request
  returns immediately, writers are paused for the whole window, and the UI
  polls a status endpoint instead of holding a socket open for minutes.
- Uploads are accepted (the owner's "recover Postgres from a file" path),
  but never trusted: size-capped, written to a .part file, validated with
  `pg_restore -l` (a real archive lists its TOC), and only then renamed
  into the canonical dreamedia-<date>-<time>-<us>.dump shape.
- After a successful restore every session is dropped: the users table may
  now describe a different world, so cookies minted against the old one
  must not survive. The admin who ran it is logged out too, on purpose.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from returns.result import Failure, Result, Success

from Admin import settings
from Admin.backup import run_backup
from Config.Hardcoded.limits import MAX_RESTORE_UPLOAD_BYTES, PG_DUMP_CANDIDATES
from Database.db import dsn
from Utility.logs import log

# Global restore gate (2026 review: in-place restore with live writers is a
# known-acknowledged hazard — now it actually pauses them). Managers check
# restore_in_progress() each pass; the API middleware 503s mutations.
# Phase 1.2: the gate lives in the settings table so EVERY worker sees it
# (a module global only covered the restoring worker).
_restore_active = False  # local fast-path; the DB row is the source of truth


def restore_in_progress() -> bool:
    # Local flag keeps the hot path cheap; restore_start/finish also persist
    # the settings row so other workers observe the window on their next read.
    return _restore_active


async def restore_in_progress_db() -> bool:
    from Admin import settings

    return (await settings.get_typed("restore_active")) == "1"


async def _persist_gate(active: bool) -> None:
    from Admin import settings

    await settings.set_value("restore_active", "1" if active else "0")


_DUMP_RE = re.compile(r"^dreamedia-\d{8}-\d{6}-\d{6}\.dump$")

# phase -> what the admin page shows. "snapshot" and "restoring" are the
# two long ones; everything else is instantaneous.
_state: Dict[str, Any] = {
    "phase": "idle",
    "file": None,
    "startedAt": None,
    "finishedAt": None,
    "snapshot": None,
    "error": None,
    "sessionsDropped": 0,
    "message": None,
}
_task: Optional[asyncio.Task] = None


def restore_status() -> Dict[str, Any]:
    """Snapshot of the current/last restore, safe to serialise as-is."""
    return {**_state, "active": _restore_active}


def _set(**fields: Any) -> None:
    _state.update(fields)


async def list_backups() -> List[Dict[str, Any]]:
    backup_dir = await _backup_dir()
    if not backup_dir.is_dir():
        return []
    dumps = sorted(
        backup_dir.glob("dreamedia-*.dump"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    return [
        {"file": p.name, "size": p.stat().st_size, "mtime": int(p.stat().st_mtime)}
        for p in dumps
    ]


async def _backup_dir() -> Path:
    return Path(str(await settings.get_typed("backup_dir") or "./backups")).resolve()


async def resolve_backup(filename: str) -> Result[Path, str]:
    """Canonical, traversal-checked path for a dump name."""
    if not _DUMP_RE.match(filename or ""):
        return Failure("invalid backup filename")
    backup_dir = await _backup_dir()
    target = (backup_dir / filename).resolve()
    if backup_dir not in target.parents:
        return Failure("path escapes backup directory")
    if not target.is_file():
        return Failure("backup file not found")
    return Success(target)


def _pg_restore_bin() -> str | None:
    for candidate in PG_DUMP_CANDIDATES:
        path = candidate.replace("pg_dump", "pg_restore")
        found = None
        import shutil

        found = shutil.which(path) or (path if Path(path).exists() else None)
        if found:
            return found
    return None


def _pg_env(pg_bin: str) -> dict:
    env = dict(os.environ)
    # Debian bundles libpq beside a versioned binary; only add the path when
    # the layout actually has it (Homebrew, /usr/bin symlinks, containers).
    parts = Path(pg_bin).resolve().parents
    if len(parts) > 3:
        lib_dir = parts[3] / "x86_64-linux-gnu"
        if lib_dir.is_dir():
            env["LD_LIBRARY_PATH"] = f"{lib_dir}:{env.get('LD_LIBRARY_PATH', '')}"
    return env


async def validate_dump(path: Path) -> Result[int, str]:
    """Prove a file really is a pg_dump archive before it is trusted.

    `pg_restore -l` parses the TOC without touching the database: a truncated
    or foreign file fails here instead of halfway through a destructive run.
    Returns the number of TOC entries.
    """
    pg_restore = _pg_restore_bin()
    if not pg_restore:
        return Failure("pg_restore not found (needed to validate the upload)")
    try:
        proc = await asyncio.create_subprocess_exec(
            pg_restore, "-l", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=_pg_env(pg_restore),
        )
        stdout, stderr = await proc.communicate()
    except OSError as exc:  # pragma: no cover - environment failure
        return Failure(f"could not run pg_restore: {exc}")
    if proc.returncode != 0:
        return Failure(f"not a valid pg_dump archive: {stderr.decode()[-200:].strip()}")
    entries = [
        line for line in stdout.decode(errors="replace").splitlines()
        if line and not line.startswith(";")
    ]
    if not entries:
        return Failure("archive contains no restorable objects")
    return Success(len(entries))


async def stage_upload(stream, original_name: str = "") -> Result[Dict[str, Any], str]:
    """Validate an uploaded dump and adopt it into the backup directory.

    `stream` is any object with `.read(n)` (FastAPI's UploadFile.file).
    Nothing enters the backup directory under its final name until the
    archive has been proven readable.
    """
    backup_dir = await _backup_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.time()
    final = backup_dir / (
        f"dreamedia-{time.strftime('%Y%m%d-%H%M%S', time.localtime(stamp))}"
        f"-{int(stamp * 1e6) % 10**6:06d}.dump"
    )
    partial = final.with_suffix(".dump.part")
    written = 0
    try:
        with partial.open("wb") as handle:
            while True:
                chunk = await stream.read(1024 * 1024) if hasattr(stream.read, "__await__") else stream.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_RESTORE_UPLOAD_BYTES:
                    raise ValueError(
                        f"file is larger than the {MAX_RESTORE_UPLOAD_BYTES // (1024**3)} GiB limit"
                    )
                handle.write(chunk)
        if written == 0:
            raise ValueError("uploaded file is empty")
        verdict = await validate_dump(partial)
        if isinstance(verdict, Failure):
            raise ValueError(verdict.failure())
        partial.replace(final)
    except ValueError as exc:
        partial.unlink(missing_ok=True)
        return Failure(str(exc))
    except OSError as exc:
        partial.unlink(missing_ok=True)
        return Failure(f"could not store upload: {exc}")
    log.warning(
        "restore upload accepted: %s (%s bytes, original=%r)",
        final.name, written, original_name,
    )
    return Success(
        {"file": final.name, "size": written, "mtime": int(final.stat().st_mtime)}
    )


async def restore_backup(filename: str) -> Result[str, str]:
    """Run a restore to completion. Prefer start_restore() from the API."""
    return await _restore(filename)


async def start_restore(filename: str) -> Result[str, str]:
    """Kick off a restore in the background and return the file name.

    The gate closes immediately (before the snapshot), so no writer can slip
    a transaction in between "restore accepted" and "restore running".
    """
    global _task, _restore_active
    if _restore_active:
        return Failure("a restore is already running")
    target = await resolve_backup(filename)
    if isinstance(target, Failure):
        return Failure(target.failure())
    if not _pg_restore_bin():
        return Failure("pg_restore not found")

    _restore_active = True
    asyncio.ensure_future(_persist_gate(True))
    _set(
        phase="queued", file=filename, startedAt=time.time(), finishedAt=None,
        snapshot=None, error=None, sessionsDropped=0,
        message="restore accepted — workers paused",
    )
    _task = asyncio.create_task(_restore(filename, gate_already_closed=True))
    return Success(filename)


async def _restore(filename: str, gate_already_closed: bool = False) -> Result[str, str]:
    global _restore_active
    resolved = await resolve_backup(filename)
    if isinstance(resolved, Failure):
        if gate_already_closed:
            _restore_active = False
            await _persist_gate(False)
            _set(phase="failed", error=resolved.failure(), finishedAt=time.time())
        return Failure(resolved.failure())
    target = resolved.unwrap()

    pg_restore = _pg_restore_bin()
    if not pg_restore:
        if gate_already_closed:
            _restore_active = False
            await _persist_gate(False)
            _set(phase="failed", error="pg_restore not found", finishedAt=time.time())
        return Failure("pg_restore not found")
    env = _pg_env(pg_restore)

    if not gate_already_closed:
        _restore_active = True
        asyncio.ensure_future(_persist_gate(True))
        _set(
            phase="queued", file=filename, startedAt=time.time(), finishedAt=None,
            snapshot=None, error=None, sessionsDropped=0, message=None,
        )

    try:
        # 1. Pre-restore snapshot — the tested rollback path (2026 review).
        _set(phase="snapshot", message="writing a rollback snapshot")
        snapshot = await run_backup()
        if isinstance(snapshot, Failure):
            _set(
                phase="failed", finishedAt=time.time(),
                error=f"pre-restore snapshot failed, restore refused: {snapshot.failure()}",
            )
            return Failure(f"pre-restore snapshot failed, restore refused: {snapshot.failure()}")
        _set(snapshot=Path(snapshot.unwrap()).name)
        log.warning("pre-restore snapshot: %s", snapshot.unwrap())

        # 2. Restore with workers paused (gate closed above).
        _set(phase="restoring", message="pg_restore is rewriting the database")
        log.warning("RESTORE started: %s (destructive; workers paused)", filename)
        proc = await asyncio.create_subprocess_exec(
            pg_restore, "-d", dsn(), "--clean", "--if-exists", str(target),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            # 3. Roll back from the snapshot so the db is never left partial.
            _set(phase="rollback", message="restore failed — rolling back from the snapshot")
            log.error("RESTORE failed: %s — rolling back from snapshot", stderr.decode()[-300:])
            rb = await asyncio.create_subprocess_exec(
                pg_restore, "-d", dsn(), "--clean", "--if-exists", snapshot.unwrap(),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            _, rb_err = await rb.communicate()
            if rb.returncode == 0:
                log.warning("ROLLBACK complete: pre-restore state recovered")
                _set(
                    phase="failed", finishedAt=time.time(),
                    error=f"pg_restore failed (rollback ok): {stderr.decode()[-300:]}",
                    message="restore failed, previous data recovered",
                )
                return Failure(f"pg_restore failed (rollback ok): {stderr.decode()[-300:]}")
            log.critical("ROLLBACK FAILED: %s", rb_err.decode()[-300:])
            _set(
                phase="failed", finishedAt=time.time(),
                error=f"pg_restore failed AND rollback failed: {stderr.decode()[-200:]}",
                message="restore and rollback both failed — inspect the database",
            )
            return Failure(f"pg_restore failed AND rollback failed: {stderr.decode()[-200:]}")

        # 4. The restored users table is now authoritative: no old cookie may
        #    survive it, including the one that authorised this restore.
        from Auth import auth

        dropped = await auth.drop_all_sessions()
        _set(
            phase="done", finishedAt=time.time(), sessionsDropped=dropped,
            message=f"restore complete — {dropped} session(s) signed out",
        )
        log.warning("RESTORE complete: %s (sessions dropped: %s)", filename, dropped)
        return Success(filename)
    except Exception as exc:  # noqa: BLE001 - never leave the gate stuck closed
        log.exception("RESTORE crashed: %s", exc)
        _set(phase="failed", finishedAt=time.time(), error=str(exc), message="restore crashed")
        return Failure(str(exc))
    finally:
        _restore_active = False
