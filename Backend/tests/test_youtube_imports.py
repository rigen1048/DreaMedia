"""Focused contracts for the staged durable extension YouTube-import queue."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
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
async def test_enqueue_returns_without_resolution_and_encrypts_payloads(monkeypatch):
    connection = FakeConnection()

    async def vault_key(user_id):
        assert user_id == 12
        return b"test-vault-key"

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(
        youtube_imports,
        "encrypt",
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
    assert result["resolved"] == 0
    assert result["added"] == 0
    assert result["skipped"] == 1
    assert result["failed"] == 1

    inserted_items = next(call[2] for call in connection.calls if call[0] == "executemany")
    assert [row[3] for row in inserted_items] == ["queued", "skipped", "failed"]
    assert all(row[2].startswith(b"cipher:") for row in inserted_items)
    assert inserted_items[2][4].startswith(b"cipher:")
    insert_job = next(
        call for call in connection.calls
        if call[0] == "execute" and "INSERT INTO yt_import_jobs" in call[1]
    )
    assert insert_job[2][2:8] == ("queued", 3, 2, 0, 1, 1)
    assert insert_job[2][8].startswith(b"cipher:")
    assert b'"domain":"Media"' in insert_job[2][8]


@pytest.mark.asyncio
async def test_status_is_owner_scoped_and_reports_resolution_progress(monkeypatch):
    job = {
        "job_id": "job-1", "status": "running", "requested": 4,
        "processed": 2, "resolved": 3, "added": 1, "skipped": 1, "failed": 0,
    }
    connection = FakeConnection(job=job, errors=[])

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
        "job_id": "job-1", "status": "running", "requested": 4,
        "processed": 2, "resolved": 3, "added": 1, "skipped": 1,
        "failed": 0, "errors": [],
    }
    fetchrow = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "WHERE job_id = $1 AND user_id = $2" in fetchrow[1]
    assert "resolved" in fetchrow[1]
    assert fetchrow[2] == ("job-1", 12)


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
async def test_processing_uses_resolved_add_source_helper_and_preserves_skip_existing(monkeypatch):
    calls = []
    completed = []
    resolved = {
        "rss_id": "UCexample", "name": "Example", "url": "https://youtube.com/@example",
        "logo": "https://img.example/logo.jpg",
    }

    async def add_source(user_id, metadata, **kwargs):
        calls.append((user_id, metadata, kwargs))
        return {"channel_id": 41, "created": False}

    async def complete(item, key, status, error=None):
        completed.append((item, key, status, error))

    ciphertexts = {
        b"link": "https://youtube.com/@example",
        b"options": '{"kind":"withhold","withhold":3,"domain":"Media","subdomain":"Animation"}',
        b"resolved": '{"rss_id":"UCexample","name":"Example","url":"https://youtube.com/@example","logo":"https://img.example/logo.jpg"}',
    }
    monkeypatch.setattr(youtube_imports, "add_resolved_youtube_channel_source", add_source)
    monkeypatch.setattr(youtube_imports, "_complete_processing", complete)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, value: ciphertexts[value])
    item = {
        "id": 1, "job_id": "job-1", "user_id": 12,
        "link_enc": b"link", "options_enc": b"options", "resolved_enc": b"resolved",
        "claim_token": "claim-1",
    }
    store = object()

    await youtube_imports._process_claim(item, b"test-vault-key", store)

    assert calls == [(
        12,
        resolved,
        {
            "kind": "withhold", "withhold": 3, "domain": "Media",
            "subdomain": "Animation", "skip_existing": True, "store": store,
        },
    )]
    assert completed == [(item, b"test-vault-key", "skipped", None)]


@pytest.mark.asyncio
async def test_single_add_and_bulk_share_resolve_then_store_helpers(monkeypatch):
    calls = []
    metadata = {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None}

    async def resolve(link):
        calls.append(("resolve", link))
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
    assert calls[0] == ("resolve", "https://youtube.com/@x")
    assert calls[1][0:2] == ("write", 12)
    assert calls[1][2]["rss_id"] == "UCx"
    assert calls[1][2]["kind"] == "tracking"


@pytest.mark.asyncio
async def test_resolver_stage_persists_metadata_without_doing_source_write(monkeypatch):
    resolved = {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None}
    calls = []

    async def resolve(link):
        calls.append(("resolve", link))
        return resolved

    async def complete(item, key, result, error=None):
        calls.append(("complete", result, error))

    monkeypatch.setattr(youtube_imports, "resolve_youtube_channel", resolve)
    monkeypatch.setattr(youtube_imports, "_complete_resolution", complete)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, _value: "https://youtube.com/@x")
    item = {
        "id": 1, "job_id": "job-1", "link_enc": b"link", "claim_token": "token",
        "start_at": datetime.now(timezone.utc),
    }

    await youtube_imports._resolve_claim(item, b"key")

    assert calls == [
        ("resolve", "https://youtube.com/@x"),
        ("complete", resolved, None),
    ]


@pytest.mark.asyncio
async def test_claim_reserves_a_global_slot_and_staggered_start(monkeypatch):
    start_at = datetime.now(timezone.utc)

    class ClaimConnection(FakeConnection):
        async def fetchrow(self, query, *args):
            self.calls.append(("fetchrow", query, args))
            if "SELECT slot_id" in query:
                return {"slot_id": 3}
            if "SELECT i.id" in query:
                return {
                    "id": 99, "job_id": "job-1", "link_enc": b"link",
                    "options_enc": b"options", "resolved_enc": None,
                }
            if "UPDATE yt_import_dispatcher" in query:
                return {"start_at": start_at}
            return None

    connection = ClaimConnection()

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)

    item = await youtube_imports._claim_stage_item(12, "resolve")

    assert item["user_id"] == 12
    assert item["stage"] == "resolve" and item["slot_id"] == 3
    assert item["start_at"] == start_at
    queries = [call[1] for call in connection.calls if call[0] == "fetchrow"]
    assert "FOR UPDATE SKIP LOCKED" in queries[0]
    assert "FOR UPDATE OF i SKIP LOCKED" in queries[1]
    assert "j.options_enc" in queries[1]
    assert "i.options_enc" not in queries[1]
    assert "GREATEST(next_start_at, clock_timestamp())" in queries[2]
    slot_update = next(call for call in connection.calls if "UPDATE yt_import_worker_slots SET claim_token" in call[1])
    assert slot_update[2][0:2] == ("resolve", 3)


@pytest.mark.asyncio
async def test_no_free_global_slot_prevents_item_claim(monkeypatch):
    class NoSlotConnection(FakeConnection):
        async def fetchrow(self, query, *args):
            self.calls.append(("fetchrow", query, args))
            return None

    connection = NoSlotConnection()

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)

    assert await youtube_imports._claim_stage_item(12, "process") is None
    assert len([call for call in connection.calls if call[0] == "fetchrow"]) == 1
    assert "stage = $1" in connection.calls[0][1]


@pytest.mark.asyncio
async def test_resolution_completion_counts_resolved_and_releases_slot_with_cooldown(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 1")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())
    item = {
        "id": 7, "job_id": "job-1", "claim_token": "claim-1",
        "stage": "resolve", "slot_id": 2,
    }
    metadata = {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None}

    await youtube_imports._complete_resolution(item, b"key", metadata)

    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 3
    assert "resolved_enc = $3" in updates[0][1]
    assert updates[0][2][1] == "resolved"
    assert updates[0][2][2].startswith(b"cipher:")
    assert "resolved = resolved + 1" in updates[1][1]
    assert "make_interval(secs => $4::double precision)" in updates[2][1]
    assert updates[2][2] == ("resolve", 2, "claim-1", 2)


@pytest.mark.asyncio
async def test_processing_completion_counts_final_write_and_releases_slot(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 1")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())
    item = {
        "id": 7, "job_id": "job-1", "claim_token": "claim-1",
        "stage": "process", "slot_id": 6,
    }

    await youtube_imports._complete_processing(item, b"key", "failed", "DB write failed")

    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 3
    assert "resolved_enc = NULL" in updates[0][1]
    assert "processed = processed + 1" in updates[1][1]
    assert updates[1][2] == ("job-1", 0, 0, 1)
    assert updates[2][2] == ("process", 6, "claim-1")


@pytest.mark.asyncio
async def test_stale_completion_does_not_increment_progress_but_releases_only_matching_slot(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 0")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())

    await youtube_imports._complete_resolution(
        {
            "id": 7, "job_id": "job-1", "claim_token": "old-claim",
            "stage": "resolve", "slot_id": 1,
        },
        b"key",
        {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None},
    )

    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 2  # conditional item update + conditional slot release only
    assert all("yt_import_jobs" not in call[1] for call in updates)
    assert "claim_token = $3" in updates[-1][1]


@pytest.mark.asyncio
async def test_canceled_resolution_requeues_item_and_releases_slot(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 1")

    async def get_pool():
        return FakePool(connection)

    async def canceled_sleep(_delay):
        raise asyncio.CancelledError()

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.asyncio, "sleep", canceled_sleep)
    item = {
        "id": 7, "job_id": "job-1", "claim_token": "claim-1",
        "stage": "resolve", "slot_id": 2,
        "start_at": datetime.now(timezone.utc) + timedelta(seconds=30),
    }

    with pytest.raises(asyncio.CancelledError):
        await youtube_imports._resolve_claim(item, b"key")

    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 2
    assert "SET status = $2, claimed_at = NULL, claim_token = NULL" in updates[0][1]
    assert updates[0][2] == (7, "queued", "resolving", "claim-1")
    assert "make_interval(secs => $4::double precision)" in updates[1][1]
    assert updates[1][2] == ("resolve", 2, "claim-1", 2)


def test_stage_migration_is_idempotent_and_requeues_legacy_running_items():
    schema = Path(__file__).parents[1].joinpath("Database", "schema.sql").read_text()
    assert "ADD COLUMN IF NOT EXISTS resolved_enc BYTEA" in schema
    assert "ADD COLUMN IF NOT EXISTS resolved INTEGER NOT NULL DEFAULT 0" in schema
    assert "SET status = 'queued', claimed_at = NULL, claim_token = NULL" in schema
    assert "generate_series(1, 8)" in schema and "generate_series(1, 16)" in schema
    assert "CREATE TABLE IF NOT EXISTS yt_import_dispatcher" in schema


@pytest.mark.parametrize(
    ("setting", "expected"),
    [(None, 8), ("5", 5), ("0", 1), ("80", 8), ("invalid", 8)],
)
def test_resolver_worker_count_uses_default_override_and_global_bound(monkeypatch, setting, expected):
    if setting is None:
        monkeypatch.delenv("DREAMEDIA_YT_IMPORT_WORKERS", raising=False)
    else:
        monkeypatch.setenv("DREAMEDIA_YT_IMPORT_WORKERS", setting)

    assert youtube_imports.import_worker_count() == expected


@pytest.mark.parametrize(
    ("setting", "expected"),
    [(None, 16), ("6", 6), ("0", 1), ("40", 16), ("invalid", 16)],
)
def test_processor_worker_count_is_separate_and_bounded(monkeypatch, setting, expected):
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
    ])

    assert [item["status"] for item in items] == [
        "queued", "skipped", "queued", "queued", "failed",
    ]


@pytest.mark.asyncio
async def test_shared_resolver_extracts_youtube_metadata(monkeypatch):
    from Orchestrator.Yt.Fetch import convert

    expected = SimpleNamespace(
        rss_id="UCx", name="Channel", url="https://youtube.com/@x", logo=None
    )
    monkeypatch.setattr(convert, "resolve_channel", lambda _link: Success(expected))

    result = await youtube_imports.resolve_youtube_channel("https://youtube.com/@x")

    assert result == {
        "rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None,
    }


def test_import_worker_retry_delay_grows_with_jitter_and_is_capped(monkeypatch):
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

    results = await asyncio.gather(
        *(youtube_imports._claim_next_stage_item("process") for _ in range(16))
    )

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

    assert scans == 2
    assert item is None and key is None
    assert delay > 0
