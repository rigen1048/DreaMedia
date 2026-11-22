import asyncio

import pytest

from Database import leader


class FakeConnection:
    def __init__(self, *, fail_lock=False):
        self.closed = False
        self.fail_lock = fail_lock
        self.calls = []
        self.terminated = False
        self.active = 0
        self.peak_active = 0

    def is_closed(self):
        return self.closed

    def terminate(self):
        self.terminated = True
        self.closed = True

    async def fetchval(self, query, *args):
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        self.calls.append((query, args))
        try:
            await asyncio.sleep(0.005)
            if self.fail_lock and "pg_try_advisory_lock" in query:
                raise OSError("injected connection failure")
            if "pg_try_advisory_lock" in query:
                return True
            return 1
        finally:
            self.active -= 1


@pytest.mark.asyncio
async def test_concurrent_leader_checks_serialize_cold_connection_and_lock(monkeypatch):
    connection = FakeConnection()
    connect_calls = 0

    async def fake_connect(_dsn):
        nonlocal connect_calls
        connect_calls += 1
        await asyncio.sleep(0)
        return connection

    monkeypatch.setattr(leader.asyncpg, "connect", fake_connect)
    monkeypatch.setattr(leader, "dsn", lambda: "postgresql://unit-test")
    monkeypatch.setattr(leader, "_conn", None)
    monkeypatch.setattr(leader, "_loop", None)
    monkeypatch.setattr(leader, "_is_leader", False)

    results = await asyncio.gather(*(leader._check_leader() for _ in range(12)))

    assert results == [True] * 12
    assert connect_calls == 1
    assert connection.peak_active == 1
    assert sum("pg_try_advisory_lock" in query for query, _ in connection.calls) == 1
    assert sum(query == "SELECT 1" for query, _ in connection.calls) == 11


@pytest.mark.asyncio
async def test_failed_leader_connection_is_terminated_and_recreated(monkeypatch):
    failed = FakeConnection(fail_lock=True)
    healthy = FakeConnection()
    connections = iter([failed, healthy])
    connect_calls = 0

    async def fake_connect(_dsn):
        nonlocal connect_calls
        connect_calls += 1
        return next(connections)

    monkeypatch.setattr(leader.asyncpg, "connect", fake_connect)
    monkeypatch.setattr(leader, "dsn", lambda: "postgresql://unit-test")
    monkeypatch.setattr(leader, "_conn", None)
    monkeypatch.setattr(leader, "_loop", None)
    monkeypatch.setattr(leader, "_is_leader", False)

    assert await leader._check_leader() is False
    assert failed.terminated is True
    assert leader._conn is None
    assert leader._is_leader is False

    assert await leader._check_leader() is True
    assert connect_calls == 2
    assert leader._conn is healthy
