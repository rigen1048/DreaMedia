"""Blackbox tests for all three backup styles with export verification.

The three backups:
  1. Linkwarden-style .txt portable backup   (export_data / import_data)
  2. CSV backup per media                    (export_csv / import_csv)
  3. pg_dump binary backup                   (adminRunBackup + pg_restore -l)

Every export is exercised through the public API and either re-imported
(round-trip) or verified restorable (pg_restore -l lists the archive's
contents). A backup that cannot be restored is a rumor.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import uuid
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from Database.Admin import settings as settings_mod
from Admin.restore import _pg_restore_bin
from App.main import app
from Database import db, vault
from Database.crypto import encrypt
from Media.Yt.SQL.store import PgStore

pytestmark = pytest.mark.asyncio


async def gql(client: AsyncClient, query: str, variables: dict | None = None):
    response = await client.post("/graphql", json={"query": query, "variables": variables or {}})
    return response.json()


async def gql_ok(client: AsyncClient, query: str, variables: dict | None = None):
    body = await gql(client, query, variables)
    assert "errors" not in body, body["errors"]
    return body["data"]


async def login_client(client: AsyncClient, username: str, password: str):
    """Log in via the public REST endpoint: sets the session cookie AND
    populates the in-process vault key (same process as GraphQL resolvers,
    which read the vault via `vault.get`)."""
    response = await client.post("/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


@pytest.fixture
async def user_client(tmp_path):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://dreamedia.test") as client:
        await settings_mod.set_value("backup_dir", str(tmp_path))
        username = f"bb_{uuid.uuid4().hex[:10]}"
        data = await gql_ok(
            client,
            "mutation($u:String!,$p:String!){ signup(username:$u,password:$p){ id username } }",
            {"u": username, "p": "backup-test-pass"},
        )
        user_id = data["signup"]["id"]
        await login_client(client, username, "backup-test-pass")
        client.user_id = user_id  # type: ignore[attr-defined]
        yield client
        pool = await db.get_pool()
        async with pool.acquire() as con:
            await con.execute("DELETE FROM users WHERE id = $1", user_id)


@pytest.fixture
async def admin_client(user_client, tmp_path):
    """Same client, promoted to admin (roles are read per request)."""
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE users SET role = 'admin' WHERE id = $1", user_client.user_id)
    await settings_mod.set_value("backup_dir", str(tmp_path))
    return user_client


async def seed_yt_channel(user_id: int) -> int:
    store = PgStore()
    return (await store.add_tracking(
        user_id, "UCblackbox", "Blackbox Chan", "https://www.youtube.com/@blackbox",
        kind="tracking",
    )).unwrap()


async def seed_anime_entry(user_id: int) -> int:
    key = await vault.get(user_id)
    assert key is not None, "vault must be unlocked (login first)"
    pool = await db.get_pool()
    async with pool.acquire() as con:
        return await con.fetchval(
            "INSERT INTO ani_entries "
            "(user_id, anilist_id, title_enc, cover_enc, list, cursor_season, cursor_episode, cursor_position_seconds) "
            "VALUES ($1, 20, $2, $3, 'watching', 2, 40, 90) RETURNING id",
            user_id, encrypt(key, "Naruto"), encrypt(key, ""),
        )


async def delete_anime_entry(user_id: int) -> None:
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("DELETE FROM ani_entries WHERE user_id = $1 AND anilist_id = 20", user_id)


async def anime_view(user_id: int):
    from Media.Ani.SQL.store import AniStore
    return await AniStore().management_view(user_id)


# ---------------------------------------------------------------- txt -------

async def test_backup_txt_roundtrip(user_client):
    """Portable .txt export then re-import restores channels + anime + cursor."""
    user_id = user_client.user_id
    store = PgStore()

    cid = await seed_yt_channel(user_id)
    await seed_anime_entry(user_id)

    # ---- export -----------------------------------------------------------
    body = await gql_ok(user_client, "query { exportData }")
    txt = body["exportData"]
    payload = json.loads(txt)
    assert payload["format"] == "dreamedia-portable"
    assert payload["version"] == 1
    assert any(ch["name"] == "Blackbox Chan" for ch in payload["youtube"]["channels"])
    assert any(e["title"] == "Naruto" for e in payload["anime"]["entries"])

    # ---- delete everything, then re-import --------------------------------
    await store.delete_channel(user_id, cid)
    await delete_anime_entry(user_id)
    assert [c for c in await store.channels_view(user_id) if c["name"] == "Blackbox Chan"] == []
    assert [e for e in await anime_view(user_id) if e["title"] == "Naruto"] == []

    result = await gql_ok(
        user_client,
        "mutation($p:String!){ importData(payload:$p) { channels cards anime skipped } }",
        {"p": txt},
    )
    counts = result["importData"]
    assert counts["channels"] >= 1, counts
    assert counts["anime"] >= 1, counts

    # ---- verify restored --------------------------------------------------
    channels = await store.channels_view(user_id)
    assert any(c["name"] == "Blackbox Chan" for c in channels)
    restored = [e for e in await anime_view(user_id) if e["title"] == "Naruto"][0]
    assert restored["cursor"]["season"] == 2
    assert restored["cursor"]["episode"] == 40
    assert restored["cursor"]["position_seconds"] == 90


# ------------------------------------------------------------- csv youtube --

async def test_backup_csv_youtube_roundtrip(user_client):
    """YouTube CSV: FreeTube-compatible headers, round-trip restores mode /
    words / category. Re-import skips network resolution because rss_id is
    present in our own export."""
    user_id = user_client.user_id
    store = PgStore()

    cid = (await store.add_tracking(
        user_id, "UCcsvyt", "CSV YT Chan", "https://www.youtube.com/@csvyt",
        kind="wordscan", words=["alpha", "beta"],
    )).unwrap()
    await store.assign_category(user_id, cid, "Tech", "Cloud")

    # ---- export -----------------------------------------------------------
    body = await gql_ok(user_client, 'query { exportCsv(media: "yt") }')
    csv_text = body["exportCsv"]
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    assert rows[0]["Channel Title"] == "CSV YT Chan"
    assert rows[0]["Channel URL"].startswith("https://www.youtube.com/@csvyt")
    assert rows[0]["Mode"] == "wordscan"
    assert rows[0]["Words"] == "alpha,beta"
    assert rows[0]["Domain"] == "Tech"

    # ---- delete, re-import ------------------------------------------------
    await store.delete_channel(user_id, cid)
    assert [c for c in await store.channels_view(user_id) if c["name"] == "CSV YT Chan"] == []

    result = await gql_ok(
        user_client,
        'mutation($m:String!,$p:String!){ importCsv(media:$m, payload:$p) { imported skipped errors } }',
        {"m": "yt", "p": csv_text},
    )
    imported = result["importCsv"]["imported"]
    assert imported >= 1, result["importCsv"]
    assert result["importCsv"]["skipped"] == 0

    # ---- verify restored --------------------------------------------------
    restored = [c for c in await store.channels_view(user_id) if c["name"] == "CSV YT Chan"][0]
    assert restored["kind"] == "wordscan"
    assert restored["words"] == ["alpha", "beta"]
    assert restored["domain"] == "Tech"
    assert restored["subdomain"] == "Cloud"


# ------------------------------------------------------------- csv anime --

async def test_backup_csv_anime_roundtrip(user_client):
    """Anime CSV round-trip: title / AniList id / cursor position survive
    export and re-import."""
    user_id = user_client.user_id
    await seed_anime_entry(user_id)

    # ---- export -----------------------------------------------------------
    body = await gql_ok(user_client, 'query { exportCsv(media: "ani") }')
    csv_text = body["exportCsv"]
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    assert rows[0]["Title"] == "Naruto"
    assert rows[0]["AniList ID"] == "20"
    assert rows[0]["List"] == "watching"
    assert rows[0]["Cursor Season"] == "2"
    assert rows[0]["Cursor Episode"] == "40"
    assert rows[0]["Cursor Position"] == "90"

    # ---- delete, re-import ------------------------------------------------
    await delete_anime_entry(user_id)
    assert [e for e in await anime_view(user_id) if e["title"] == "Naruto"] == []

    result = await gql_ok(
        user_client,
        'mutation($m:String!,$p:String!){ importCsv(media:$m, payload:$p) { imported skipped errors } }',
        {"m": "ani", "p": csv_text},
    )
    assert result["importCsv"]["imported"] >= 1, result["importCsv"]
    assert result["importCsv"]["skipped"] == 0

    # ---- verify restored --------------------------------------------------
    restored = [e for e in await anime_view(user_id) if e["title"] == "Naruto"][0]
    assert restored["cursor"]["season"] == 2
    assert restored["cursor"]["episode"] == 40
    assert restored["cursor"]["position_seconds"] == 90


# ------------------------------------------------------------- pg_dump ------

async def test_backup_pg_dump_verified(admin_client, tmp_path):
    """pg_dump binary backup: file exists, is non-empty, and pg_restore -l
    lists the archive contents (a backup that can't restore is a rumor)."""
    body = await gql_ok(admin_client, "mutation { adminRunBackup }")
    path = Path(body["adminRunBackup"])
    assert path.is_file() and path.stat().st_size > 0

    pg_restore = _pg_restore_bin()
    assert pg_restore is not None, "pg_restore binary must be available"
    # pg_dump/pg_restore link against libpq from the extracted postgres
    # userland — mirror Admin/backup.py and point LD_LIBRARY_PATH at it.
    import os

    env = dict(os.environ)
    restore_parents = Path(pg_restore).parents
    lib_dir = (
        restore_parents[3] / "x86_64-linux-gnu"
        if len(restore_parents) > 3 else Path("/usr/lib")
    )
    if lib_dir.is_dir():
        env["LD_LIBRARY_PATH"] = f"{lib_dir}:{env.get('LD_LIBRARY_PATH', '')}"
    proc = await asyncio.create_subprocess_exec(
        pg_restore, "-l", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    stdout, _ = await proc.communicate()
    assert proc.returncode == 0, "pg_restore -l must succeed on the backup"
    listing = stdout.decode()
    assert "TABLE" in listing.upper(), listing[:500]
