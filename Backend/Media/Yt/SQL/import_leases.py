"""Token-fenced helpers for durable per-user import worker leases."""
from __future__ import annotations

from typing import Any

IMPORT_SECTION_LEASE_SECONDS = 120


class ImportWorkerLeaseLost(RuntimeError):
    """Raised when a worker cannot prove current ownership of its queue section."""


async def renew_import_worker_lease(
    connection: Any,
    user_id: int,
    worker_section: int,
    owner_token: str,
) -> bool:
    """Extend a live lease while taking its row lock for the transaction.

    Callers keep the surrounding transaction open across the protected writes.
    A competing process cannot take over the section until that transaction
    finishes, even if the original lease deadline passes during the write.
    """
    renewed = await connection.fetchval(
        "UPDATE yt_import_worker_leases SET lease_until = "
        "now() + ($4 * interval '1 second') "
        "WHERE user_id = $1 AND worker_section = $2 AND owner_token = $3 "
        "AND lease_until > now() RETURNING 1",
        user_id,
        worker_section,
        owner_token,
        IMPORT_SECTION_LEASE_SECONDS,
    )
    return renewed is not None
