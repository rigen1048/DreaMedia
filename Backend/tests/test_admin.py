"""Admin surface tests (M1/M2/M5): authorisation, settings floors, backups,
upload validation, restore guards and user/role management.

Everything goes through the public API (GraphQL + the three REST endpoints
that cannot be GraphQL), with real Postgres. A real destructive restore is
exercised in the browser suite (`qa/e2e.py`) where the database is disposable;
here the guards and the upload validator are proven, because a unit test that
drops and recreates the shared test database mid-suite would be sabotage.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from Admin import restore as restore_mod
from Admin import settings as settings_mod
from App.main import app
from Database import db

pytestmark = pytest.mark.asyncio


async def gql(client: AsyncClient, query: str, variables: dict | None = None):
    response = await client.post("/graphql", json={"query": query, "variables": variables or {}})
    return response.json()


async def gql_ok(client: AsyncClient, query: str, variables: dict | None = None):
    body = await gql(client, query, variables)
    assert "errors" not in body, body["errors"]
    return body["data"]


@pytest.fixture
async def user_client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://dreamedia.test") as client:
        username = f"adm_{uuid.uuid4().hex[:10]}"
        data = await gql_ok(
            client,
            "mutation($u:String!,$p:String!){ signup(username:$u,password:$p){ id } }",
            {"u": username, "p": "admin-test-pass"},
        )
        client.user_id = data["signup"]["id"]  # type: ignore[attr-defined]
        client.username = username  # type: ignore[attr-defined]
        yield client
        pool = await db.get_pool()
        async with pool.acquire() as con:
            await con.execute("DELETE FROM users WHERE id = $1", client.user_id)


@pytest.fixture(autouse=True)
async def _writable_backup_dir(tmp_path):
    """Point backups at a temp dir for every admin test.

    The live settings row may say `/backups` (the container path), which the
    host test process cannot write. Tests must not inherit deployment paths.
    """
    original = await settings_mod.get_all()
    await settings_mod.set_value("backup_dir", str(tmp_path))
    yield tmp_path
    await settings_mod.set_value("backup_dir", original.get("backup_dir", "./backups"))


@pytest.fixture
async def admin_client(user_client):
    """Same client, promoted in the database (roles are read per request)."""
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE users SET role = 'admin' WHERE id = $1", user_client.user_id)
    return user_client


async def test_admin_fields_require_admin(user_client):
    for query in (
        "{ adminOverview { backupCount } }",
        "{ adminBackups { file } }",
        "{ adminSettings { key } }",
        "{ adminUsers { id } }",
        'mutation { adminRunBackup }',
        'mutation { adminSetSetting(key:"backup_keep_latest", value:"3") }',
        'mutation { adminStartRestore(filename:"dreamedia-20260101-000000-000000.dump") }',
    ):
        body = await gql(user_client, query)
        assert body.get("errors"), query
        assert "Admin only" in body["errors"][0]["message"], body["errors"][0]


async def test_anonymous_admin_fields_rejected():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://dreamedia.test") as client:
        body = await gql(client, "{ adminOverview { backupCount } }")
    assert body.get("errors")
    assert "not authenticated" in body["errors"][0]["message"]


async def test_overview_and_settings_describe_floors(admin_client):
    data = await gql_ok(
        admin_client,
        """{
             adminOverview { backupCount keepLatest frequencyHours backupDir userCount adminCount
                             restore { phase active sessionsDropped } }
             adminSettings { key value floor kind }
           }""",
    )
    overview = data["adminOverview"]
    assert overview["keepLatest"] >= 2
    assert overview["userCount"] >= 1
    assert overview["adminCount"] >= 1
    assert overview["restore"]["phase"] in {"idle", "done", "failed", "queued"}
    floors = {row["key"]: row for row in data["adminSettings"]}
    assert set(floors) == {
        "backup_dir", "backup_keep_latest", "backup_frequency_hours", "stale_claim_seconds",
    }
    assert floors["backup_keep_latest"]["floor"] == "2"
    assert floors["stale_claim_seconds"]["floor"] == "300"


async def test_setting_floor_is_enforced(admin_client):
    body = await gql(
        admin_client,
        'mutation { adminSetSetting(key:"backup_keep_latest", value:"1") }',
    )
    assert body.get("errors")
    assert "cannot be below 2" in body["errors"][0]["message"]

    body = await gql(
        admin_client,
        'mutation { adminSetSetting(key:"nonsense", value:"1") }',
    )
    assert body.get("errors")
    assert "Unknown setting" in body["errors"][0]["message"]


async def test_setting_roundtrip_and_backup_listing(admin_client, tmp_path):
    original = await settings_mod.get_all()
    try:
        await gql_ok(
            admin_client,
            "mutation($v:String!){ adminSetSetting(key:\"backup_dir\", value:$v) }",
            {"v": str(tmp_path)},
        )
        data = await gql_ok(admin_client, "{ adminSettings { key value } }")
        assert {row["key"]: row["value"] for row in data["adminSettings"]}["backup_dir"] == str(tmp_path)

        data = await gql_ok(admin_client, "mutation { adminRunBackup }")
        created = Path(data["adminRunBackup"])
        assert created.is_file() and created.stat().st_size > 0

        backups = (await gql_ok(admin_client, "{ adminBackups { file size mtime } }"))["adminBackups"]
        assert any(row["file"] == created.name for row in backups)
    finally:
        await settings_mod.set_value("backup_dir", original.get("backup_dir", "./backups"))


async def test_upload_rejects_non_archive(admin_client, tmp_path):
    response = await admin_client.post(
        "/admin/restore/upload",
        files={"file": ("notes.dump", b"this is not a pg_dump", "application/octet-stream")},
    )
    body = response.json()
    assert body["ok"] is False
    assert "valid pg_dump" in body["error"]


async def test_upload_accepts_real_dump_and_stages_it(admin_client, tmp_path):
    original = await settings_mod.get_all()
    try:
        await gql_ok(
            admin_client,
            "mutation($v:String!){ adminSetSetting(key:\"backup_dir\", value:$v) }",
            {"v": str(tmp_path)},
        )
        created = Path((await gql_ok(admin_client, "mutation { adminRunBackup }"))["adminRunBackup"])
        payload = created.read_bytes()

        response = await admin_client.post(
            "/admin/restore/upload",
            files={"file": ("my-laptop-backup.dump", payload, "application/octet-stream")},
        )
        body = response.json()
        assert body["ok"] is True, body
        assert body["file"].startswith("dreamedia-") and body["file"].endswith(".dump")
        assert body["size"] == len(payload)
        assert (tmp_path / body["file"]).is_file()
    finally:
        await settings_mod.set_value("backup_dir", original.get("backup_dir", "./backups"))


async def test_restore_rejects_bad_names_and_reports_status(admin_client):
    for filename in ("../etc/passwd", "notadump.dump", "dreamedia-20260101-000000-000000.dump"):
        body = await gql(
            admin_client,
            "mutation($f:String!){ adminStartRestore(filename:$f) }",
            {"f": filename},
        )
        assert body.get("errors"), filename

    response = await admin_client.get("/admin/restore/status")
    body = response.json()
    assert body["ok"] is True
    assert body["active"] is False
    assert body["phase"] in {"idle", "done", "failed"}


async def test_restore_refuses_while_one_is_running(admin_client, monkeypatch):
    monkeypatch.setattr(restore_mod, "_restore_active", True)
    # The middleware gate closes before the resolver runs: a second restore
    # cannot even be requested, and no other mutation can slip in either.
    response = await admin_client.post(
        "/graphql",
        json={"query": 'mutation { adminStartRestore(filename:"dreamedia-20260101-000000-000000.dump") }'},
    )
    assert response.status_code == 503
    assert "restore in progress" in response.json()["detail"]

    # Reads still work during a restore — the progress poller depends on it.
    status = await admin_client.get("/admin/restore/status")
    assert status.status_code == 200


async def test_last_admin_cannot_be_demoted_or_deleted(admin_client):
    pool = await db.get_pool()
    async with pool.acquire() as con:
        await con.execute("UPDATE users SET role = 'user' WHERE role = 'admin' AND id <> $1", admin_client.user_id)
        other = await con.fetchval(
            "INSERT INTO users (username, argon2_hash, role) VALUES ($1,$2,'user') RETURNING id",
            f"other_{uuid.uuid4().hex[:8]}", "x",
        )
    try:
        body = await gql(
            admin_client,
            "mutation($id:Int!){ adminSetUserRole(userId:$id, role:\"user\") }",
            {"id": admin_client.user_id},
        )
        assert body.get("errors")
        assert "last admin" in body["errors"][0]["message"]

        body = await gql(admin_client, "mutation($id:Int!){ adminDeleteUser(userId:$id) }", {"id": admin_client.user_id})
        assert body.get("errors")
        assert "cannot delete the account" in body["errors"][0]["message"]

        # A plain user is deletable, and deleting them proves the guard is
        # about "last admin", not "any user".
        body = await gql(admin_client, "mutation($id:Int!){ adminDeleteUser(userId:$id) }", {"id": other})
        assert "errors" not in body, body["errors"]
        assert body["data"]["adminDeleteUser"] is True
    finally:
        async with pool.acquire() as con:
            await con.execute("DELETE FROM users WHERE id = $1", other)
            await con.execute("UPDATE users SET role = 'admin' WHERE id = $1", admin_client.user_id)


async def test_promote_then_demote_other_user(admin_client):
    pool = await db.get_pool()
    async with pool.acquire() as con:
        target = await con.fetchval(
            "INSERT INTO users (username, argon2_hash, role) VALUES ($1,$2,'user') RETURNING id",
            f"target_{uuid.uuid4().hex[:8]}", "x",
        )
    try:
        data = await gql_ok(
            admin_client,
            "mutation($id:Int!){ adminSetUserRole(userId:$id, role:\"admin\") }",
            {"id": target},
        )
        assert data["adminSetUserRole"] == "admin"
        users = (await gql_ok(admin_client, "{ adminUsers { id role } }"))["adminUsers"]
        assert any(row["id"] == target and row["role"] == "admin" for row in users)

        data = await gql_ok(
            admin_client,
            "mutation($id:Int!){ adminSetUserRole(userId:$id, role:\"user\") }",
            {"id": target},
        )
        assert data["adminSetUserRole"] == "user"
    finally:
        async with pool.acquire() as con:
            await con.execute("DELETE FROM users WHERE id = $1", target)


async def test_password_reset_requires_admin_and_short_password(admin_client):
    body = await gql(
        admin_client,
        "mutation($id:Int!){ adminResetPassword(userId:$id, password:\"123\") }",
        {"id": admin_client.user_id},
    )
    assert body.get("errors")
    assert "at least 6" in body["errors"][0]["message"]
