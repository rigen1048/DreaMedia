"""Infra integration tests — run against the live dev Postgres.

Covers: migration, crypto round-trip + blind index, vault, auth
(signup/login/first-user-admin/session), admin settings with floors,
PgStore encrypted CRUD + D9 pause, backup dump + retention floor.
"""
import os
import shutil
from pathlib import Path

import pytest
from returns.result import Failure, Success

from Admin import backup, settings
from Auth import auth
from Database import db, vault
from Database.crypto import decrypt, derive_key, encrypt, index_hash
from Database.pg_store import PgStore

TEST_USER = "testuser_infra"


@pytest.fixture(scope="session", autouse=True)
async def _migrate():
    await db.migrate()
    await settings.seed_defaults()
    # Idempotent: wipe leftovers from earlier runs (FK cascade cleans children).
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("DELETE FROM users WHERE username = $1", TEST_USER)
    yield
    await db.close()


@pytest.fixture(autouse=True)
async def _fresh_pool():
    """asyncpg pools bind to their creation loop; pytest-asyncio gives
    each test a new loop → recreate the pool per test."""
    await db.close()
    yield


# ---------- crypto (pure) ----------

def test_crypto_roundtrip():
    key = derive_key("hunter2", TEST_USER)
    ct = encrypt(key, "mr beast fake stunts")
    assert ct is not None and ct != b"mr beast fake stunts"
    assert decrypt(key, ct) == "mr beast fake stunts"
    # Random nonce: same plaintext encrypts differently…
    assert encrypt(key, "x") != encrypt(key, "x")
    # …but the blind index is deterministic.
    assert index_hash(key, "https://youtu.be/x") == index_hash(key, "https://youtu.be/x")


def test_wrong_key_cannot_decrypt():
    k1, k2 = derive_key("pw1", "alice"), derive_key("pw2", "alice")
    with pytest.raises(Exception):
        decrypt(k2, encrypt(k1, "secret"))


# ---------- settings (D26, floors) ----------

async def test_settings_floor_rejects_zero_retention():
    result = await settings.set_value("backup_keep_latest", "0")
    assert isinstance(result, Failure)
    assert "hardcoded floor" in result.failure()


async def test_settings_set_and_read():
    assert isinstance(await settings.set_value("backup_keep_latest", "4"), Success)
    assert await settings.get_typed("backup_keep_latest") == 4


async def test_settings_unknown_key_rejected():
    assert isinstance(await settings.set_value("aggressiveness", "9000"), Failure)


# ---------- auth (D27, D9) ----------

async def test_signup_login_and_first_user_is_admin():
    signup = await auth.signup(TEST_USER, "correct horse battery")
    assert isinstance(signup, Success)
    assert signup.unwrap()["role"] == "admin"  # first user in the DB

    login = await auth.login(TEST_USER, "correct horse battery")
    assert isinstance(login, Success)
    assert vault.is_unlocked(login.unwrap()["user_id"])

    bad = await auth.login(TEST_USER, "wrong password")
    assert isinstance(bad, Failure)


async def test_sessions_resolve_and_expire():
    login = (await auth.login(TEST_USER, "correct horse battery")).unwrap()
    assert await auth.resolve_session(login["token"]) == login["user_id"]
    assert await auth.resolve_session("garbage-token") is None


# ---------- PgStore: encrypted CRUD + D9 pause ----------

async def test_pgstore_roundtrip_and_d9_pause():
    user_id = (await auth.login(TEST_USER, "correct horse battery")).unwrap()["user_id"]
    store = PgStore()

    added = await store.add_tracking(
        user_id, "UCtest123", "Test Channel", "https://youtube.com/channel/UCtest123"
    )
    assert isinstance(added, Success)

    # Vault unlocked → due; then drop the key → D9 pause.
    assert any(s.user_id == user_id for s in await store.get_due())
    await vault.drop(user_id)
    assert not any(s.user_id == user_id for s in await store.get_due())

    # Re-login restores access; raw DB never holds plaintext.
    await auth.login(TEST_USER, "correct horse battery")
    pool = await db.get_pool()
    async with pool.acquire() as con:
        raw = await con.fetchval(
            "SELECT name_enc FROM yt_channels WHERE id = $1", added.unwrap()
        )
    assert b"Test Channel" not in bytes(raw)


async def test_pgstore_video_dedupe_via_blind_index():
    user_id = (await auth.login(TEST_USER, "correct horse battery")).unwrap()["user_id"]
    store = PgStore()
    subs = [s for s in await store.get_due() if s.user_id == user_id]
    payload = ({1: {"id": "v1", "title": "T", "url": "https://youtu.be/v1",
                    "thumbnail": "", "published": "2026-01-01"}},)
    assert await store.save_videos(subs[0], payload) == 1
    assert await store.save_videos(subs[0], payload) == 0  # duplicate rejected


# ---------- backup (D13/D26) ----------

async def test_backup_dump_and_retention(tmp_path):
    await settings.set_value("backup_dir", str(tmp_path))
    await settings.set_value("backup_keep_latest", "2")
    for _ in range(3):
        result = await backup.run_backup()
        assert isinstance(result, Success), result
    dumps = sorted(tmp_path.glob("dreamedia-*.dump"))
    assert len(dumps) == 2  # retention pruned to the floor-compliant value
    assert all(d.stat().st_size > 0 for d in dumps)
    await settings.set_value("backup_dir", "./backups")
