from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from Auth import notify_router


class _Connection:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.fetch_args = None
        self.execute_args = None
        self.fetchrow_args = None

    async def fetch(self, query, *args):
        self.fetch_args = (query, args)
        return self.rows

    async def execute(self, query, *args):
        self.execute_args = (query, args)
        return "UPDATE 2"

    async def fetchrow(self, query, *args):
        self.fetchrow_args = (query, args)
        return {"id": 55, "created_at": datetime.now(timezone.utc)}


class _Acquire:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, *_args):
        return None


class _Pool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return _Acquire(self.connection)


@pytest.mark.asyncio
async def test_bell_list_is_shaped_from_encrypted_postgres_rows(monkeypatch):
    created_at = datetime(2026, 11, 22, 1, 2, 3, tzinfo=timezone.utc)
    rows = [
        {
            "id": 41,
            "media": "yt",
            "kind": "tracking_video",
            "payload_enc": b"encrypted",
            "seen": False,
            "created_at": created_at,
        }
    ]
    record = {
        "title": "A new video",
        "message": "Creator · Track",
        "level": "info",
        "url": "https://example.test/video",
        "payload": {"videoId": "v1"},
    }
    connection = _Connection(rows)
    monkeypatch.setattr(notify_router.vault, "get", _async_value(b"user-key"))
    monkeypatch.setattr(notify_router, "decrypt", lambda _key, _blob: json.dumps(record))
    monkeypatch.setattr(notify_router, "get_pool", _async_value(_Pool(connection)))

    result = await notify_router.list_notifications(user_id=7, limit=25)

    assert result == {
        "notifications": [
            {
                "id": 41,
                "rowId": 41,
                "userId": 7,
                "media": "yt",
                "kind": "tracking_video",
                "title": "A new video",
                "message": "Creator · Track",
                "level": "info",
                "url": "https://example.test/video",
                "createdAt": "2026-11-22T01:02:03+00:00",
                "payload": {"videoId": "v1"},
                "seen": False,
            }
        ]
    }
    query, args = connection.fetch_args
    assert "FROM notifications WHERE user_id = $1" in query
    assert args == (7, 25)


@pytest.mark.asyncio
async def test_mark_seen_updates_only_the_authenticated_users_rows(monkeypatch):
    connection = _Connection()
    monkeypatch.setattr(notify_router, "get_pool", _async_value(_Pool(connection)))

    result = await notify_router.mark_seen(
        notify_router.SeenBody(ids=[41, 42], seen=False), user_id=7
    )

    assert result == {"ok": True, "changed": 2}
    query, args = connection.execute_args
    assert "WHERE user_id = $1 AND id = ANY($2)" in query
    assert args == (7, [41, 42], False)


def test_notification_routes_require_a_session_cookie():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(notify_router.router)
    with TestClient(app) as client:
        assert client.get("/notifications").status_code == 401
        assert client.post("/notifications/seen", json={"ids": [41]}).status_code == 401


def test_notification_list_reports_locked_vault(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(notify_router.vault, "get", _async_value(None))
    app = FastAPI()
    app.include_router(notify_router.router)

    async def authenticated_user():
        return 7

    app.dependency_overrides[notify_router.current_user_id] = authenticated_user
    with TestClient(app) as client:
        response = client.get("/notifications")

    assert response.status_code == 423
    assert "Vault is locked" in response.json()["detail"]


@pytest.mark.asyncio
async def test_notification_producer_writes_only_to_postgres(monkeypatch):
    from Utility import notify as notify_module

    connection = _Connection()
    monkeypatch.setattr(notify_module.vault, "get", _async_value(b"user-key"))
    monkeypatch.setattr(notify_module, "encrypt", lambda _key, _value: b"encrypted")
    monkeypatch.setattr(notify_module, "get_pool", _async_value(_Pool(connection)))

    row_id = await notify_module.notify(
        7,
        "ani",
        "release_confirmed",
        {"season": 2},
        title="Example series",
    )

    assert row_id == 55
    query, args = connection.fetchrow_args
    assert "INSERT INTO notifications" in query
    assert args[:3] == (7, "ani", "release_confirmed")


def _async_value(value):
    async def result(*_args, **_kwargs):
        return value

    return result
