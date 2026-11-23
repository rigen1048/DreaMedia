"""Schema bootstrap (D58/D62): shared tables, then each media's own create.

Order matters:
  1. Database/Init/schema.sql      — cross-media tables (users, settings,
     alerts, sessions, extension lane) + the alerts rename migration
  2. Media.Yt.SQL.process.create   — every yt_* table, created by its media
  3. Media.Ani.SQL.process.create  — every ani_* table, created by its media
  4. Database/Init/constraints.sql — FK drift repair, references everything

Every file is idempotent; the whole set is replayed on every boot.
"""
from __future__ import annotations

from pathlib import Path

from Media.Ani.SQL.process import create as ani_create
from Media.Yt.SQL.process import create as yt_create

_DIR = Path(__file__).resolve().parent


async def run(con) -> None:
    """Apply the full schema on one connection."""
    await con.execute((_DIR / "schema.sql").read_text())
    await con.execute(yt_create.DDL)
    await con.execute(ani_create.DDL)
    await con.execute((_DIR / "constraints.sql").read_text())
