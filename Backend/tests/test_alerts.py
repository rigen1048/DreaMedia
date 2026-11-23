"""Alert lane tests (D60/D61): the bell is backend-driven, unhappy-path only.

The old /notifications REST router is deleted — alerts are served by the
supergraph (`alerts`, `markAlertsSeen`) and written only via
Utility.alert.send_alert.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest


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


def _async_value(value):
    async def result(*_args, **_kwargs):
        return value

    return result


@pytest.mark.asyncio
async def test_send_alert_writes_encrypted_row_to_alerts_table(monkeypatch):
    from Utility import alert as alert_module

    connection = _Connection()
    monkeypatch.setattr(alert_module.vault, "get", _async_value(b"user-key"))
    monkeypatch.setattr(alert_module, "encrypt", lambda _key, _value: b"encrypted")
    monkeypatch.setattr(alert_module, "get_pool", _async_value(_Pool(connection)))

    row_id = await alert_module.send_alert(
        7,
        "yt",
        "channel_deleted",
        {"channel": "Example"},
        title="Channel may got deleted",
    )

    assert row_id == 55
    query, args = connection.fetchrow_args
    assert "INSERT INTO alerts" in query
    assert args[:3] == (7, "yt", "channel_deleted")


@pytest.mark.asyncio
async def test_send_alert_skips_when_vault_locked(monkeypatch):
    """D9: a locked vault must never store plaintext — the alert is dropped."""
    from Utility import alert as alert_module

    connection = _Connection()
    monkeypatch.setattr(alert_module.vault, "get", _async_value(None))
    monkeypatch.setattr(alert_module, "get_pool", _async_value(_Pool(connection)))

    row_id = await alert_module.send_alert(7, "yt", "channel_deleted", {})

    assert row_id is None
    assert connection.fetchrow_args is None


@pytest.mark.asyncio
async def test_store_alerts_reads_alerts_table(monkeypatch):
    created_at = datetime(2026, 11, 22, 1, 2, 3, tzinfo=timezone.utc)
    rows = [
        {
            "id": 41,
            "media": "yt",
            "kind": "channel_deleted",
            "payload_enc": b"encrypted",
            "seen": False,
            "created_at": created_at,
        }
    ]
    connection = _Connection(rows)
    from Database import pg_store

    monkeypatch.setattr(pg_store.vault, "get", _async_value(b"user-key"))
    monkeypatch.setattr(pg_store, "decrypt", lambda _key, _blob: '{"title": "Channel may got deleted"}')
    monkeypatch.setattr(pg_store, "get_pool", _async_value(_Pool(connection)))

    result = await pg_store.PgStore().alerts(7, limit=25)

    assert result[0]["id"] == 41
    assert result[0]["payload"] == {"title": "Channel may got deleted"}
    query, args = connection.fetch_args
    assert "FROM alerts WHERE user_id = $1" in query
    assert args == (7, 25)
