"""Automated backup scheduling (D33): create on frequency, prune on cap.

Restore stays manual (owner's call, D33) — this loop only ever CREATES
dumps and prunes old ones (retention lives inside run_backup).

Cadence is re-read from admin settings every cycle, so changing
backup_frequency_hours at runtime takes effect without a restart.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

from returns.result import Failure

from Admin import backup, settings
from Utility.logs import log

_TICK_SECONDS = 300.0  # how often we check whether a backup is due


async def backup_is_due(now: float | None = None) -> bool:
    """True when the newest dump is older than backup_frequency_hours
    (or no dump exists at all)."""
    now = now or time.time()
    backup_dir = Path(str(await settings.get_typed("backup_dir") or "./backups"))
    frequency_hours = int(await settings.get_typed("backup_frequency_hours") or 24)
    dumps = sorted(
        backup_dir.glob("dreamedia-*.dump"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    if not dumps:
        return True
    return (now - dumps[0].stat().st_mtime) >= frequency_hours * 3600


async def run_if_due() -> bool:
    """One tick: take a backup when due. Returns True when a dump was made."""
    if not await backup_is_due():
        return False
    result = await backup.run_backup()
    if isinstance(result, Failure):
        log.error("scheduled backup failed: %s", result.failure())
        return False
    log.info("scheduled backup complete (D33)")
    return True


async def run_forever() -> None:
    log.info("backup scheduler started (D33)")
    while True:
        try:
            await run_if_due()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("backup scheduler tick failed; continuing")
        await asyncio.sleep(_TICK_SECONDS)
