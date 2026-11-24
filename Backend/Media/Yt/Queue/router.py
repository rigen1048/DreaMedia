"""REST endpoints for extension/bulk source ingestion (D62).

All ingestion writes to the unified queue table (`yt_import_jobs` /
`yt_import_items`) with `user_id`. Eight per-user workers then drain the
queue at 1 req/s per worker.

Endpoints:
  POST /extension/sources/import  — multipart .json file upload
  GET  /extension/sources/status   — poll job status (for missed WS messages)
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from Extension.tokens import user_for_token
from Extension.ws_router import take_pending_messages
from Media.Yt.Queue.worker import enqueue_sources

router = APIRouter(prefix="/extension", tags=["extension-sources"])


async def _ext_user_id(
    request,  # FastAPI Request — auth via extension token, not cookie
) -> int:
    """Resolve user_id from the extension token header.

    The extension sends its per-user token in `X-Extension-Token`. One token
    maps to one user, so multiple browsers/extensions can share the same
    token (multi-browser support).
    """
    token = request.headers.get("x-extension-token")
    if not token:
        raise HTTPException(status_code=401, detail="missing extension token")
    user_id = await user_for_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="invalid or revoked extension token")
    return user_id


@router.post("/sources/import")
async def import_sources(
    request,
    file: UploadFile = File(...),
    user_id: int = Depends(_ext_user_id),
) -> dict[str, Any]:
    """Upload a .json file containing one or more YouTube channel sources.

    File format (array of source objects):
      [
        {"link": "https://youtube.com/@handle"},
        {"link": "https://youtube.com/channel/UC..."},
        {"link": "@handle"}
      ]

    A single object is also accepted:
      {"link": "https://youtube.com/@handle"}

    Rank, type, domain, and subdomain are determined backend-side from RSS
    analysis — the client only supplies links.
    """
    raw = await file.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid JSON")

    # Normalize to a list of links
    links: list[str] = []
    if isinstance(data, dict):
        link = data.get("link")
        if not link:
            raise HTTPException(status_code=400, detail="missing 'link' field")
        links.append(str(link).strip())
    elif isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict):
                link = entry.get("link")
                if link:
                    links.append(str(link).strip())
            elif isinstance(entry, str):
                links.append(entry.strip())
    else:
        raise HTTPException(status_code=400, detail="JSON must be an object or array of sources")

    if not links:
        raise HTTPException(status_code=400, detail="no sources found in file")

    if len(links) > 2000:
        raise HTTPException(status_code=400, detail="a file can contain at most 2000 sources")

    job_id = await enqueue_sources(user_id, links)

    return {
        "ok": True,
        "jobId": job_id,
        "requested": len(links),
        "message": f"{len(links)} source(s) queued for import",
    }


@router.get("/sources/status")
async def import_status(
    request,
    job_id: str,
    user_id: int = Depends(_ext_user_id),
) -> dict[str, Any]:
    """Poll the status of an import job. Used by the extension when it
    misses a WebSocket `success`/`news` message."""
    from Database.db import get_pool

    pool = await get_pool()
    async with pool.acquire() as con:
        job = await con.fetchrow(
            """
            SELECT job_id, status, requested, processed, resolved, added, skipped, failed
            FROM yt_import_jobs
            WHERE job_id = $1 AND user_id = $2
            """,
            job_id,
            user_id,
        )
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")

        items = await con.fetch(
            """
            SELECT ordinal, status, error_enc
            FROM yt_import_items
            WHERE job_id = $1
            ORDER BY ordinal
            """,
            job_id,
        )

    pending = take_pending_messages(user_id)

    return {
        "jobId": job["job_id"],
        "status": job["status"],
        "requested": job["requested"],
        "processed": job["processed"],
        "resolved": job["resolved"],
        "added": job["added"],
        "skipped": job["skipped"],
        "failed": job["failed"],
        "items": [
            {"ordinal": i["ordinal"], "status": i["status"], "error": None}
            for i in items
        ],
        "pendingMessages": pending,
    }
