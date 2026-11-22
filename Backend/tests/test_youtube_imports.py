"""Focused contracts for durable extension YouTube-import jobs."""
from contextlib import asynccontextmanager

import pytest

from Extension import youtube_imports


class FakeConnection:
    def __init__(self, job=None, errors=None, update_result="UPDATE 1"):
        self.job = job
        self.errors = errors or []
        self.update_result = update_result
        self.calls = []

    @asynccontextmanager
    async def transaction(self):
        yield

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return self.update_result

    async def executemany(self, query, rows):
        self.calls.append(("executemany", query, list(rows)))

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self.job

    async def fetch(self, query, *args):
        self.calls.append(("fetch", query, args))
        return self.errors


class FakePool:
    def __init__(self, connection):
        self.connection = connection

    @asynccontextmanager
    async def acquire(self):
        yield self.connection


@pytest.mark.asyncio
async def test_enqueue_returns_without_resolution_and_encrypts_payloads(monkeypatch):
    connection = FakeConnection()
    pool = FakePool(connection)

    async def vault_key(user_id):
        assert user_id == 12
        return b"test-vault-key"

    async def get_pool():
        return pool

    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(
        youtube_imports, "encrypt",
        lambda _key, value: f"cipher:{value}".encode() if value is not None else None,
    )

    result = await youtube_imports.enqueue_youtube_import(
        12,
        [
            "https://www.youtube.com/@example",
            "https://youtube.com/@example/",
            "https://attacker.example/@bad",
        ],
        kind="wordscan",
        words=[" trailer ", "devlog"],
        domain=" Media ",
        subdomain=" Animation ",
    )

    assert result["status"] == "queued"
    assert result["requested"] == 3
    assert result["processed"] == 2
    assert result["added"] == 0
    assert result["skipped"] == 1
    assert result["failed"] == 1
    assert result["job_id"]

    inserted_items = next(call[2] for call in connection.calls if call[0] == "executemany")
    assert [row[3] for row in inserted_items] == ["queued", "skipped", "failed"]
    assert all(row[2].startswith(b"cipher:") for row in inserted_items)
    assert inserted_items[2][4].startswith(b"cipher:")
    insert_job = next(call for call in connection.calls if call[0] == "execute" and "INSERT INTO yt_import_jobs" in call[1])
    assert insert_job[2][2:7] == ("queued", 3, 2, 1, 1)
    assert insert_job[2][7].startswith(b"cipher:")
    assert b'"domain":"Media"' in insert_job[2][7]


@pytest.mark.asyncio
async def test_status_is_owner_scoped_and_decrypts_only_failed_item_errors(monkeypatch):
    job = {
        "job_id": "job-1", "status": "partial", "requested": 4,
        "processed": 4, "added": 2, "skipped": 1, "failed": 1,
    }
    connection = FakeConnection(job=job, errors=[{"error_enc": b"encrypted-error"}])

    async def get_pool():
        return FakePool(connection)

    async def vault_key(user_id):
        assert user_id == 12
        return b"test-vault-key"

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, value: "bad YouTube link" if value else None)

    result = await youtube_imports.get_youtube_import_status(12, "job-1")

    assert result == {
        "job_id": "job-1", "status": "partial", "requested": 4,
        "processed": 4, "added": 2, "skipped": 1, "failed": 1,
        "errors": ["bad YouTube link"],
    }
    fetchrow = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "WHERE job_id = $1 AND user_id = $2" in fetchrow[1]
    assert fetchrow[2] == ("job-1", 12)
    error_query = next(call for call in connection.calls if call[0] == "fetch")
    assert "status = 'failed'" in error_query[1]


@pytest.mark.asyncio
async def test_status_hides_jobs_not_owned_by_requester(monkeypatch):
    connection = FakeConnection(job=None)

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    result = await youtube_imports.get_youtube_import_status(99, "someone-elses-job")

    assert result is None
    assert not any(call[0] == "fetch" for call in connection.calls)


@pytest.mark.asyncio
async def test_worker_calls_same_add_source_helper_and_preserves_skip_existing(monkeypatch):
    calls = []
    completed = []

    async def add_source(user_id, link, **kwargs):
        calls.append((user_id, link, kwargs))
        return {"channel_id": 41, "created": False}

    async def complete_item(item, key, status, error=None):
        completed.append((item, key, status, error))

    def decrypt(_key, value):
        return {b"link": "https://youtube.com/@example", b"options": '{"kind":"withhold","withhold":3,"domain":"Media","subdomain":"Animation"}'}[value]

    monkeypatch.setattr(youtube_imports, "add_youtube_channel_source", add_source)
    monkeypatch.setattr(youtube_imports, "_complete_item", complete_item)
    monkeypatch.setattr(youtube_imports, "decrypt", decrypt)
    item = {
        "id": 1, "job_id": "job-1", "user_id": 12,
        "link_enc": b"link", "options_enc": b"options", "claim_token": "claim-1",
    }
    store = object()

    await youtube_imports._process_claim(item, b"test-vault-key", store)

    assert calls == [(
        12,
        "https://youtube.com/@example",
        {
            "kind": "withhold", "withhold": 3, "domain": "Media",
            "subdomain": "Animation", "skip_existing": True, "store": store,
        },
    )]
    assert completed == [(item, b"test-vault-key", "skipped", None)]


@pytest.mark.asyncio
async def test_completed_item_updates_progress_counters_atomically(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 1")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())

    item = {"id": 7, "job_id": "job-1", "claim_token": "claim-1"}
    await youtube_imports._complete_item(item, b"test-vault-key", "failed", "channel resolution failed")

    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 2
    assert "claim_token = $4" in updates[0][1]
    assert updates[0][2][1:3] == ("failed", b"cipher:channel resolution failed")
    assert "processed = processed + 1" in updates[1][1]
    assert "status = CASE WHEN processed + 1 >= requested" in updates[1][1]
    assert updates[1][2] == ("job-1", 0, 0, 1)



def test_channel_link_validation_deduplicates_handles_without_folding_channel_ids():
    upper_id = "UC" + ("A" * 22)
    distinct_lower_id = "UC" + "a" + ("A" * 21)
    items = youtube_imports._prepare_items([
        "https://www.youtube.com/@Example",
        "https://youtube.com/@example/",
        f"https://youtube.com/channel/{upper_id}",
        f"https://youtube.com/channel/{distinct_lower_id}",
        "http://youtube.com:443/@bad-port",
    ])

    assert [item["status"] for item in items] == [
        "queued", "skipped", "queued", "queued", "failed",
    ]


@pytest.mark.asyncio
async def test_stale_worker_claim_does_not_increment_job_progress(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 0")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())

    await youtube_imports._complete_item(
        {"id": 7, "job_id": "job-1", "claim_token": "old-claim"},
        b"test-vault-key",
        "added",
    )

    assert len([call for call in connection.calls if call[0] == "execute"]) == 1
