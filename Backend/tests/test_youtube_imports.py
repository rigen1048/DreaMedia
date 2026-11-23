"""Contracts for the durable, encrypted extension YouTube-import queue."""
import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from returns.result import Success

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
async def test_enqueue_is_fast_encrypted_validated_and_persists_one_batch(monkeypatch):
    connection = FakeConnection()

    async def vault_key(user_id):
        assert user_id == 12
        return b"test-vault-key"

    async def get_pool():
        return FakePool(connection)

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
    assert result["requested"] == 3 and result["processed"] == 2
    assert result["resolved"] == 0 and result["added"] == 0
    assert result["skipped"] == 1 and result["failed"] == 1
    inserted_items = next(call[2] for call in connection.calls if call[0] == "executemany")
    assert [row[3] for row in inserted_items] == ["queued", "skipped", "failed"]
    assert all(row[2].startswith(b"cipher:") for row in inserted_items)
    insert_job = next(
        call for call in connection.calls
        if call[0] == "execute" and "INSERT INTO yt_import_jobs" in call[1]
    )
    assert insert_job[2][2:8] == ("queued", 3, 2, 0, 1, 1)
    assert insert_job[2][8].startswith(b"cipher:")
    assert b'"domain":"Media"' in insert_job[2][8]


@pytest.mark.asyncio
async def test_status_is_owner_scoped_and_reports_progress(monkeypatch):
    job = {
        "job_id": "job-1", "status": "running", "requested": 4,
        "processed": 2, "resolved": 3, "added": 1, "skipped": 1, "failed": 0,
    }
    connection = FakeConnection(job=job)

    async def get_pool():
        return FakePool(connection)

    async def vault_key(user_id):
        assert user_id == 12
        return b"test-vault-key"

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, value: "bad link" if value else None)

    result = await youtube_imports.get_youtube_import_status(12, "job-1")
    assert result == {
        "job_id": "job-1", "status": "running", "requested": 4,
        "processed": 2, "resolved": 3, "added": 1, "skipped": 1,
        "failed": 0, "errors": [], "failed_items": [],
    }
    query = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "WHERE job_id = $1 AND user_id = $2" in query[1]
    assert query[2] == ("job-1", 12)


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
async def test_claim_uses_durable_row_lock_without_global_slot(monkeypatch):
    connection = FakeConnection(job={
        "id": 99, "job_id": "job-1", "link_enc": b"link",
        "options_enc": b"options", "resolved_enc": None,
    })

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    item = await youtube_imports._claim_stage_item(12, "resolve")

    assert item["user_id"] == 12 and item["stage"] == "resolve"
    assert item["id"] == 99 and item["claim_token"]
    fetch = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "FOR UPDATE OF i SKIP LOCKED" in fetch[1]
    assert "make_interval(mins => $2)" in fetch[1]
    assert fetch[2][1] == youtube_imports.CLAIM_STALE_AFTER_MINUTES == 2
    assert "j.options_enc" in fetch[1]
    assert "yt_import_worker_slots" not in fetch[1]
    updates = [call for call in connection.calls if call[0] == "execute"]
    assert any("SET status = $2, claimed_at = now()" in call[1] for call in updates)
    assert any("UPDATE yt_import_jobs SET status = 'running'" in call[1] for call in updates)


@pytest.mark.asyncio
async def test_empty_claim_queue_does_not_claim_anything(monkeypatch):
    connection = FakeConnection(job=None)

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    assert await youtube_imports._claim_stage_item(12, "process") is None
    assert len([call for call in connection.calls if call[0] == "fetchrow"]) == 1


@pytest.mark.asyncio
async def test_resolution_completion_updates_progress_without_slot_release(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 1")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())
    item = {"id": 7, "job_id": "job-1", "claim_token": "claim-1"}
    metadata = {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None}

    await youtube_imports._complete_resolution(item, b"key", metadata)

    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 2
    assert "resolved_enc = $3" in updates[0][1]
    assert updates[0][2][1] == "resolved"
    assert updates[0][2][2].startswith(b"cipher:")
    assert "resolved = resolved + 1" in updates[1][1]
    assert all("yt_import_worker_slots" not in call[1] for call in updates)


@pytest.mark.asyncio
async def test_processing_completion_counts_final_write_without_slot_release(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 1")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())
    item = {"id": 7, "job_id": "job-1", "claim_token": "claim-1"}

    await youtube_imports._complete_processing(item, b"key", "failed", "DB write failed")

    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 2
    assert "resolved_enc = NULL" in updates[0][1]
    assert "processed = processed + 1" in updates[1][1]
    assert updates[1][2] == ("job-1", 0, 0, 1)


@pytest.mark.asyncio
async def test_stale_completion_does_not_increment_job_progress(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 0")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())
    await youtube_imports._complete_resolution(
        {"id": 7, "job_id": "job-1", "claim_token": "old-claim"},
        b"key",
        {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None},
    )
    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 1
    assert "claim_token = $5" in updates[0][1]


@pytest.mark.asyncio
async def test_canceled_resolution_requeues_token_checked_claim(monkeypatch):
    connection = FakeConnection()

    async def get_pool():
        return FakePool(connection)

    async def canceled_resolve(_link, _user_id):
        raise asyncio.CancelledError()

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, _value: "https://youtube.com/@x")
    monkeypatch.setattr(youtube_imports, "resolve_youtube_channel", canceled_resolve)
    item = {"id": 7, "job_id": "job-1", "claim_token": "claim-1", "user_id": 12, "link_enc": b"link"}

    with pytest.raises(asyncio.CancelledError):
        await youtube_imports._resolve_claim(item, b"key")

    update = next(call for call in connection.calls if call[0] == "execute")
    assert "SET status = $2, claimed_at = NULL, claim_token = NULL" in update[1]
    assert update[2] == (7, "queued", "resolving", "claim-1")


@pytest.mark.asyncio
async def test_processing_uses_shared_add_source_write_helper(monkeypatch):
    calls = []
    metadata = {"rss_id": "UCexample", "name": "Example", "url": "https://youtube.com/@example", "logo": None}
    cipher = {
        b"link": "https://youtube.com/@example",
        b"options": '{"kind":"withhold","withhold":3,"domain":"Media","subdomain":"Animation"}',
        b"resolved": json.dumps(metadata),
    }

    async def add_source(user_id, resolved, **kwargs):
        calls.append((user_id, resolved, kwargs))
        return {"channel_id": 41, "created": False}

    async def complete(item, key, status, error=None):
        calls.append(("complete", status, error))

    monkeypatch.setattr(youtube_imports, "add_resolved_youtube_channel_source", add_source)
    monkeypatch.setattr(youtube_imports, "_complete_processing", complete)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, value: cipher[value])
    item = {
        "id": 1, "job_id": "job-1", "user_id": 12,
        "link_enc": b"link", "options_enc": b"options", "resolved_enc": b"resolved",
        "claim_token": "claim-1",
    }
    store = object()

    await youtube_imports._process_claim(item, b"vault", store)

    assert calls[0] == (12, metadata, {
        "kind": "withhold", "withhold": 3, "domain": "Media", "subdomain": "Animation",
        "skip_existing": True, "store": store,
    })
    assert calls[1] == ("complete", "skipped", None)


@pytest.mark.asyncio
async def test_single_add_and_bulk_share_resolution_and_persistence_helpers(monkeypatch):
    calls = []
    metadata = {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None}

    async def resolve(link, user_id):
        calls.append(("resolve", link, user_id))
        return metadata

    class Store:
        async def add_extension_subscription(self, user_id, **kwargs):
            calls.append(("write", user_id, kwargs))
            return Success({"channel_id": 14, "created": True})

    monkeypatch.setattr(youtube_imports, "resolve_youtube_channel", resolve)
    result = await youtube_imports.add_youtube_channel_source(
        12, "https://youtube.com/@x", kind="tracking", store=Store()
    )

    assert result == {"channel_id": 14, "created": True}
    assert calls[0] == ("resolve", "https://youtube.com/@x", 12)
    assert calls[1][0:2] == ("write", 12)
    assert calls[1][2]["rss_id"] == "UCx"
    assert calls[1][2]["kind"] == "tracking"


@pytest.mark.asyncio
async def test_shared_resolver_uses_the_users_network_lane(monkeypatch):
    from Media.Yt.Fetch import convert

    expected = SimpleNamespace(
        rss_id="UCx", name="Channel", url="https://youtube.com/@x", logo=None
    )
    calls = []

    async def network(user_id, fn, link):
        calls.append((user_id, fn, link))
        return Success(expected)

    monkeypatch.setattr(convert, "resolve_channel", lambda _link: Success(expected))
    monkeypatch.setattr(youtube_imports, "run_youtube_network", network)

    result = await youtube_imports.resolve_youtube_channel("https://youtube.com/@x", 12)
    assert result == {
        "rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None,
    }
    assert calls == [(12, convert.resolve_channel, "https://youtube.com/@x")]


def test_import_schema_is_idempotent_and_drops_legacy_global_pacing_tables():
    from Media.Yt.SQL.process import create as yt_create

    schema = yt_create.DDL
    assert "ADD COLUMN IF NOT EXISTS resolved_enc BYTEA" in schema
    assert "ADD COLUMN IF NOT EXISTS resolved INTEGER NOT NULL DEFAULT 0" in schema
    assert "SET status = 'queued', claimed_at = NULL, claim_token = NULL" in schema
    assert "DROP TABLE IF EXISTS yt_import_worker_slots" in schema
    assert "DROP TABLE IF EXISTS yt_import_dispatcher" in schema
    assert "CREATE TABLE IF NOT EXISTS yt_import_worker_slots" not in schema
    assert "CREATE TABLE IF NOT EXISTS yt_import_dispatcher" not in schema


@pytest.mark.parametrize(
    ("setting", "expected"),
    [(None, 64), ("5", 5), ("0", 1), ("80", 64), ("invalid", 64)],
)
def test_claim_consumer_count_is_independent_of_network_pacing(monkeypatch, setting, expected):
    if setting is None:
        monkeypatch.delenv("DREAMEDIA_YT_IMPORT_WORKERS", raising=False)
    else:
        monkeypatch.setenv("DREAMEDIA_YT_IMPORT_WORKERS", setting)
    assert youtube_imports.import_worker_count() == expected


@pytest.mark.parametrize(
    ("setting", "expected"),
    [(None, 16), ("6", 6), ("0", 1), ("40", 16), ("invalid", 16)],
)
def test_async_write_worker_count_has_no_network_cooldown(monkeypatch, setting, expected):
    if setting is None:
        monkeypatch.delenv("DREAMEDIA_YT_IMPORT_PROCESS_WORKERS", raising=False)
    else:
        monkeypatch.setenv("DREAMEDIA_YT_IMPORT_PROCESS_WORKERS", setting)
    assert youtube_imports.process_worker_count() == expected


def test_channel_link_validation_deduplicates_handles_without_folding_channel_ids():
    upper_id = "UC" + ("A" * 22)
    distinct_lower_id = "UC" + "a" + ("A" * 21)
    items = youtube_imports._prepare_items([
        "https://www.youtube.com/@Example",
        "https://youtube.com/@example/",
        f"https://youtube.com/channel/{upper_id}",
        f"https://youtube.com/channel/{distinct_lower_id}",
        "http://youtube.com:443/@bad-port",
        "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
        "https://www.youtube.com/feed/channels",
    ])
    assert [item["status"] for item in items] == [
        "queued", "skipped", "queued", "queued", "failed", "failed", "failed",
    ]


@pytest.mark.asyncio
async def test_status_returns_owner_scoped_failed_links_and_retryability(monkeypatch):
    connection = FakeConnection(
        job={
            "job_id": "job-1", "status": "partial", "requested": 2,
            "processed": 2, "resolved": 1, "added": 0, "skipped": 0, "failed": 2,
        },
        errors=[
            {"link_enc": b"valid-link", "error_enc": b"valid-error"},
            {"link_enc": b"music-link", "error_enc": b"music-error"},
        ],
    )

    async def get_pool():
        return FakePool(connection)

    async def vault_key(_user_id):
        return b"test-vault-key"

    cleartext = {
        b"valid-link": "https://youtube.com/@channel",
        b"valid-error": "https://youtube.com/@channel: timed out",
        b"music-link": "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
        b"music-error": "unsupported host",
    }
    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, value: cleartext[value])

    status = await youtube_imports.get_youtube_import_status(12, "job-1")

    assert status["failed_items"] == [
        {
            "link": "https://youtube.com/@channel",
            "error": "https://youtube.com/@channel: timed out",
            "retryable": True,
        },
        {
            "link": "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
            "error": "unsupported host",
            "retryable": False,
        },
    ]
    assert status["errors"] == [item["error"] for item in status["failed_items"]]


@pytest.mark.asyncio
async def test_retry_creates_separate_job_with_only_valid_failed_links_and_original_options(monkeypatch):
    connection = FakeConnection(
        job={"status": "partial", "options_enc": b"options"},
        errors=[
            {"link_enc": b"valid-link", "error_enc": None},
            {"link_enc": b"music-link", "error_enc": None},
        ],
    )

    async def get_pool():
        return FakePool(connection)

    async def vault_key(_user_id):
        return b"test-vault-key"

    options = {
        "kind": "withhold", "words": None, "rank": None, "withhold": 3,
        "domain": "Media", "subdomain": "Animation",
    }
    cleartext = {
        b"options": json.dumps(options),
        b"valid-link": "https://www.youtube.com/@channel",
        b"music-link": "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
    }
    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, value: cleartext[value])
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())

    result = await youtube_imports.retry_youtube_import(12, "job-1")

    assert result["job_id"] and result["job_id"] != "job-1"
    assert result["requested"] == 1 and result["failed"] == 0
    lookup = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "WHERE job_id = $1 AND user_id = $2" in lookup[1]
    assert lookup[2] == ("job-1", 12)
    inserted = next(call for call in connection.calls if call[0] == "executemany")
    assert len(inserted[2]) == 1
    assert inserted[2][0][2] == b"cipher:https://www.youtube.com/@channel"
    insert_job = next(
        call for call in connection.calls
        if call[0] == "execute" and "INSERT INTO yt_import_jobs" in call[1]
    )
    assert json.loads(insert_job[2][8].decode().removeprefix("cipher:")) == options


@pytest.mark.asyncio
async def test_claim_lease_refresh_is_token_checked_and_frequent(monkeypatch):
    connection = FakeConnection()

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    item = {"id": 9, "stage": "resolve", "claim_token": "lease-token"}

    assert await youtube_imports._refresh_claim_lease(item) is True
    assert youtube_imports.CLAIM_LEASE_REFRESH_SECONDS < youtube_imports.CLAIM_STALE_AFTER_MINUTES * 60
    update = next(call for call in connection.calls if call[0] == "execute")
    assert "WHERE id = $1 AND status = $2 AND claim_token = $3" in update[1]
    assert update[2] == (9, "resolving", "lease-token")


def test_stage_poll_backoff_grows_with_jitter_and_is_capped(monkeypatch):
    monkeypatch.setattr(youtube_imports.random, "uniform", lambda low, high: high)
    assert youtube_imports._worker_retry_delay(1) == pytest.approx(2.4)
    assert youtube_imports._worker_retry_delay(2) == pytest.approx(4.8)
    assert youtube_imports._worker_retry_delay(20) == 60.0


@pytest.mark.asyncio
async def test_idle_stage_workers_share_one_pending_scan(monkeypatch):
    scans = 0

    async def no_pending_work(stage):
        nonlocal scans
        assert stage == "process"
        scans += 1
        await asyncio.sleep(0.01)
        return []

    monkeypatch.setattr(youtube_imports, "_pending_user_ids", no_pending_work)
    results = await asyncio.gather(*(
        youtube_imports._claim_next_stage_item("process") for _ in range(16)
    ))
    assert scans == 1
    assert all(item is None and key is None and delay > 0 for item, key, delay in results)


@pytest.mark.asyncio
async def test_stage_poll_recovers_after_a_transient_database_timeout(monkeypatch):
    scans = 0

    async def timeout_once(stage):
        nonlocal scans
        assert stage == "resolve"
        scans += 1
        if scans == 1:
            raise TimeoutError("injected database connect timeout")
        return []

    monkeypatch.setattr(youtube_imports, "_pending_user_ids", timeout_once)
    monkeypatch.setattr(youtube_imports, "_worker_retry_delay", lambda _attempt: 0.0)
    with pytest.raises(TimeoutError):
        await youtube_imports._claim_next_stage_item("resolve")
    item, key, delay = await youtube_imports._claim_next_stage_item("resolve")
    assert scans == 2 and item is None and key is None and delay > 0
