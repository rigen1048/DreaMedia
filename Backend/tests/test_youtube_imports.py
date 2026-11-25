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
    def __init__(self, job=None, errors=None, update_result="UPDATE 1", fetchval_result=1):
        self.job = job
        self.errors = errors or []
        self.update_result = update_result
        self.fetchval_result = fetchval_result
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

    async def fetchval(self, query, *args):
        self.calls.append(("fetchval", query, args))
        return self.fetchval_result

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
    assert [row[5] for row in inserted_items] == ["queued", "skipped", "failed"]
    assert [row[1] for row in inserted_items] == [12, 12, 12]
    assert [row[2] for row in inserted_items] == [0, 1, 2]
    assert all(row[4].startswith(b"cipher:") for row in inserted_items)
    prune = next(
        call for call in connection.calls
        if call[0] == "execute" and "DELETE FROM yt_import_jobs" in call[1]
    )
    assert "status = ANY($1::text[])" in prune[1]
    assert prune[2] == (list(youtube_imports.FINISHED_IMPORT_STATUSES),)
    insert_job = next(
        call for call in connection.calls
        if call[0] == "execute" and "INSERT INTO yt_import_jobs" in call[1]
    )
    assert insert_job[2][2:8] == ("queued", 3, 2, 0, 1, 1)
    assert insert_job[2][8].startswith(b"cipher:")
    assert b'"domain":"Media"' in insert_job[2][8]


@pytest.mark.parametrize("payload", ["[]", "null", "{"])
def test_saved_import_options_reject_invalid_or_non_object_payload(monkeypatch, payload):
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, _value: payload)

    with pytest.raises(ValueError, match="saved import settings could not be read"):
        youtube_imports._saved_import_options(b"test-vault-key", b"ciphertext")


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
        "failed": 0, "errors": [], "failed_items": [], "items": [],
    }
    query = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "WHERE job_id = $1 AND user_id = $2" in query[1]
    assert query[2] == ("job-1", 12)
    item_query = next(call for call in connection.calls if call[0] == "fetch")
    assert "AND status = 'failed'" in item_query[1]


@pytest.mark.asyncio
async def test_status_returns_ordered_rows_for_each_channel(monkeypatch):
    states = ["queued", "resolving", "resolved", "processing", "added", "skipped", "failed"]
    connection = FakeConnection(
        job={
            "job_id": "job-1", "status": "running", "requested": len(states),
            "processed": 3, "resolved": 3, "added": 1, "skipped": 1, "failed": 1,
        },
        errors=[
            {
                "ordinal": ordinal,
                "link_enc": f"link-{ordinal}".encode(),
                "error_enc": b"failed to add" if state == "failed" else None,
                "status": state,
            }
            for ordinal, state in enumerate(states)
        ],
    )

    async def get_pool():
        return FakePool(connection)

    async def vault_key(_user_id):
        return b"test-vault-key"

    def decrypt(_key, value):
        if value is None:
            return None
        if value == b"failed to add":
            return "failed to add"
        return "https://youtube.com/@channel" if value.startswith(b"link-") else None

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "decrypt", decrypt)

    result = await youtube_imports.get_youtube_import_status(12, "job-1", include_items=True)

    assert [item["status"] for item in result["items"]] == states
    assert [item["ordinal"] for item in result["items"]] == list(range(len(states)))
    assert result["items"][-1] == {
        "ordinal": 6,
        "link": "https://youtube.com/@channel",
        "status": "failed",
        "error": "failed to add",
        "retryable": True,
    }


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
async def test_worker_section_lease_is_expiring_and_owner_token_checked(monkeypatch):
    connection = FakeConnection(job={"owner_token": "section-owner"})

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    token = await youtube_imports._acquire_worker_section_lease(12, 4)

    assert token and isinstance(token, str)
    acquire = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "ON CONFLICT (user_id, worker_section) DO UPDATE SET" in acquire[1]
    assert "WHERE yt_import_worker_leases.lease_until <= now()" in acquire[1]
    assert acquire[2][0:2] == (12, 4)
    assert acquire[2][2] == token
    assert acquire[2][3] == youtube_imports.IMPORT_SECTION_LEASE_SECONDS

    await youtube_imports._release_worker_section_lease(12, 4, token)
    release = next(call for call in connection.calls if call[0] == "execute")
    assert "owner_token = $3" in release[1]
    assert release[2] == (12, 4, token)


@pytest.mark.asyncio
async def test_section_lease_is_not_acquired_while_another_process_owns_it(monkeypatch):
    connection = FakeConnection(job=None)

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    assert await youtube_imports._acquire_worker_section_lease(12, 4) is None


@pytest.mark.asyncio
async def test_claim_uses_durable_row_lock_without_global_slot(monkeypatch):
    connection = FakeConnection(job={
        "id": 99, "job_id": "job-1", "link_enc": b"link",
        "options_enc": b"options", "resolved_enc": None, "status": "queued",
    })

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    item = await youtube_imports._claim_user_import_item(12, 3, "section-owner")

    assert item["user_id"] == 12 and item["stage"] == "resolve"
    assert item["worker_section"] == 3
    assert item["worker_lease_token"] == "section-owner"
    assert item["id"] == 99 and item["claim_token"]
    fetch = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "JOIN yt_import_worker_leases l" in fetch[1]
    assert "FOR UPDATE OF i, l SKIP LOCKED" in fetch[1]
    assert "i.worker_section = $2" in fetch[1]
    assert "owner_token = $3" in fetch[1]
    assert "make_interval(mins => $4)" in fetch[1]
    assert fetch[2] == (12, 3, "section-owner", youtube_imports.CLAIM_STALE_AFTER_MINUTES)
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
    assert await youtube_imports._claim_user_import_item(12, 0, "section-owner") is None
    assert len([call for call in connection.calls if call[0] == "fetchrow"]) == 1


@pytest.mark.asyncio
async def test_resolution_completion_updates_progress_without_slot_release(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 1")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())
    item = {
        "id": 7, "job_id": "job-1", "claim_token": "claim-1", "user_id": 12,
        "worker_section": 1, "worker_lease_token": "section-owner",
    }
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
    item = {
        "id": 7, "job_id": "job-1", "claim_token": "claim-1", "user_id": 12,
        "worker_section": 1, "worker_lease_token": "section-owner",
    }

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
        {
            "id": 7, "job_id": "job-1", "claim_token": "old-claim", "user_id": 12,
            "worker_section": 1, "worker_lease_token": "section-owner",
        },
        b"key",
        {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None},
    )
    updates = [call for call in connection.calls if call[0] == "execute"]
    assert len(updates) == 1
    assert "claim_token = $5" in updates[0][1]


@pytest.mark.asyncio
async def test_terminal_progress_is_fenced_when_section_lease_is_lost(monkeypatch):
    from Media.Yt.SQL.import_leases import ImportWorkerLeaseLost

    connection = FakeConnection(fetchval_result=None)

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())
    item = {
        "id": 7, "job_id": "job-1", "claim_token": "claim-1", "user_id": 12,
        "worker_section": 1, "worker_lease_token": "expired-owner",
    }

    with pytest.raises(ImportWorkerLeaseLost):
        await youtube_imports._complete_processing(item, b"key", "added")

    assert not any(call[0] == "execute" for call in connection.calls)


@pytest.mark.asyncio
async def test_canceled_resolution_requeues_token_checked_claim(monkeypatch):
    connection = FakeConnection()

    async def get_pool():
        return FakePool(connection)

    async def canceled_resolve(user_id, _link):
        assert user_id == 12
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
        "claim_token": "claim-1", "worker_section": 2,
        "worker_lease_token": "section-owner",
    }
    store = object()

    await youtube_imports._process_claim(item, b"vault", store)

    assert calls[0] == (12, metadata, {
        "kind": "withhold", "withhold": 3, "domain": "Media", "subdomain": "Animation",
        "skip_existing": True, "store": store, "worker_section": 2,
        "worker_lease_token": "section-owner",
    })
    assert calls[1] == ("complete", "skipped", None)


@pytest.mark.asyncio
async def test_add_source_refuses_to_write_after_section_lease_is_lost(monkeypatch):
    from Media.Yt.SQL.import_leases import ImportWorkerLeaseLost
    from Media.Yt.SQL.user import store as user_store

    connection = FakeConnection(fetchval_result=None)

    async def get_pool():
        return FakePool(connection)

    async def vault_key(_user_id):
        return b"vault-key"

    monkeypatch.setattr(user_store, "get_pool", get_pool)
    monkeypatch.setattr(user_store.vault, "get", vault_key)

    with pytest.raises(ImportWorkerLeaseLost):
        await user_store.YtUserSQL().add_extension_subscription(
            12,
            channel_name="Example",
            channel_url="https://youtube.com/@example",
            kind="tracking",
            rss_id="UCexample",
            skip_existing=True,
            worker_section=2,
            worker_lease_token="expired-owner",
        )

    assert len([call for call in connection.calls if call[0] == "fetchval"]) == 1
    assert not any(call[0] == "execute" for call in connection.calls)


@pytest.mark.asyncio
async def test_single_add_and_bulk_share_resolution_and_persistence_helpers(monkeypatch):
    calls = []
    metadata = {"rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None}

    async def resolve(user_id, link):
        calls.append(("resolve", user_id, link))
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
    assert calls[0] == ("resolve", 12, "https://youtube.com/@x")
    assert calls[1][0:2] == ("write", 12)
    assert calls[1][2]["rss_id"] == "UCx"
    assert calls[1][2]["kind"] == "tracking"


@pytest.mark.asyncio
async def test_shared_resolver_uses_authenticated_youtube_network_lane(monkeypatch):
    from Media.Yt.Fetch import convert

    expected = SimpleNamespace(
        rss_id="UCx", name="Channel", url="https://youtube.com/@x", logo=None
    )
    calls = []

    async def run_youtube_network(user_id, fn, link):
        calls.append((user_id, fn, link))
        return Success(expected)

    monkeypatch.setattr(convert, "resolve_channel", lambda _link: Success(expected))
    monkeypatch.setattr(youtube_imports, "run_youtube_network", run_youtube_network)

    result = await youtube_imports.resolve_youtube_channel(12, "https://youtube.com/@x")
    assert result == {
        "rss_id": "UCx", "name": "Channel", "url": "https://youtube.com/@x", "logo": None,
    }
    assert calls == [(12, convert.resolve_channel, "https://youtube.com/@x")]


def test_worker_retry_backoff_is_jittered_and_capped(monkeypatch):
    monkeypatch.setattr(youtube_imports.random, "uniform", lambda low, high: high)

    assert youtube_imports._worker_retry_delay(1) == pytest.approx(2.4)
    assert youtube_imports._worker_retry_delay(2) == pytest.approx(4.8)
    assert youtube_imports._worker_retry_delay(20) == 60.0


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
    assert "worker_section = (i.ordinal % 8)::SMALLINT" in schema
    assert "ALTER COLUMN user_id SET NOT NULL" in schema
    assert "CREATE TABLE IF NOT EXISTS yt_import_worker_leases" in schema
    assert "PRIMARY KEY (user_id, worker_section)" in schema


def test_import_workers_are_fixed_at_eight_per_user_with_one_second_break():
    assert youtube_imports.IMPORT_WORKERS_PER_USER == 8
    assert youtube_imports.IMPORT_ITEM_DELAY_SECONDS == 1.0


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"sources": [{"link": "https://youtube.com/@one"}]},
         ["https://youtube.com/@one"]),
        ({"sources": [
            {"link": "https://youtube.com/@one"},
            {"url": "https://youtube.com/@two"},
        ]}, ["https://youtube.com/@one", "https://youtube.com/@two"]),
    ],
)
def test_json_source_payload_accepts_canonical_source_batches(payload, expected):
    assert youtube_imports.normalize_source_payload(payload) == expected


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"link": "https://youtube.com/@one"},
        {"sources": "not-an-array"},
        {"sources": []},
        {"sources": ["https://youtube.com/@one"]},
        ["https://youtube.com/@one", {}],
        "https://youtube.com/@one",
        3,
    ],
)
def test_json_source_payload_rejects_malformed_or_empty_batches(payload):
    with pytest.raises(ValueError):
        youtube_imports.normalize_source_payload(payload)


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
            {"ordinal": 0, "status": "failed", "link_enc": b"valid-link", "error_enc": b"valid-error"},
            {"ordinal": 1, "status": "failed", "link_enc": b"music-link", "error_enc": b"music-error"},
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

    status = await youtube_imports.get_youtube_import_status(12, "job-1", include_items=True)

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
    assert status["items"] == [
        {
            "ordinal": 0,
            "link": "https://youtube.com/@channel",
            "status": "failed",
            "error": "https://youtube.com/@channel: timed out",
            "retryable": True,
        },
        {
            "ordinal": 1,
            "link": "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
            "status": "failed",
            "error": "unsupported host",
            "retryable": False,
        },
    ]
    assert status["errors"] == [item["error"] for item in status["failed_items"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["partial", "completed"])
async def test_retry_creates_separate_job_with_only_valid_failed_links_and_original_options(monkeypatch, status):
    connection = FakeConnection(
        job={"status": status, "options_enc": b"options"},
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
    assert inserted[2][0][1:4] == (12, 0, 0)
    assert inserted[2][0][4] == b"cipher:https://www.youtube.com/@channel"
    insert_job = next(
        call for call in connection.calls
        if call[0] == "execute" and "INSERT INTO yt_import_jobs" in call[1]
    )
    assert json.loads(insert_job[2][8].decode().removeprefix("cipher:")) == options


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["partial", "completed"])
async def test_rerun_creates_separate_job_with_all_links_and_original_options(monkeypatch, status):
    connection = FakeConnection(
        job={"status": status, "options_enc": b"options"},
        errors=[
            {"ordinal": 0, "link_enc": b"link-one"},
            {"ordinal": 1, "link_enc": b"link-two"},
        ],
    )

    async def get_pool():
        return FakePool(connection)

    async def vault_key(user_id):
        assert user_id == 12
        return b"test-vault-key"

    options = {
        "kind": "wordscan", "words": ["trailer"], "rank": None,
        "withhold": None, "domain": "Media", "subdomain": "Animation",
    }
    cleartext = {
        b"options": json.dumps(options),
        b"link-one": "https://www.youtube.com/@one",
        b"link-two": "https://youtube.com/@two",
    }
    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "decrypt", lambda _key, value: cleartext[value])
    monkeypatch.setattr(youtube_imports, "encrypt", lambda _key, value: f"cipher:{value}".encode())

    result = await youtube_imports.rerun_youtube_import(12, "job-1")

    assert result["job_id"] and result["job_id"] != "job-1"
    assert result["requested"] == 2
    lookup = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "WHERE job_id = $1 AND user_id = $2" in lookup[1]
    assert lookup[2] == ("job-1", 12)
    inserted = next(call for call in connection.calls if call[0] == "executemany")
    assert [row[4] for row in inserted[2]] == [
        b"cipher:https://www.youtube.com/@one",
        b"cipher:https://youtube.com/@two",
    ]
    insert_job = next(
        call for call in connection.calls
        if call[0] == "execute" and "INSERT INTO yt_import_jobs" in call[1]
    )
    assert json.loads(insert_job[2][8].decode().removeprefix("cipher:")) == options


@pytest.mark.asyncio
async def test_rerun_rejects_an_active_job(monkeypatch):
    connection = FakeConnection(job={"status": "running", "options_enc": b"options"})

    async def get_pool():
        return FakePool(connection)

    async def vault_key(_user_id):
        return b"test-vault-key"

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)

    with pytest.raises(ValueError, match="wait for the import to finish"):
        await youtube_imports.rerun_youtube_import(12, "job-1")
    assert not any(call[0] == "execute" for call in connection.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["partial", "completed"])
async def test_delete_finished_import_history_is_owner_scoped(monkeypatch, status):
    connection = FakeConnection(job={"status": status}, update_result="DELETE 1")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)

    assert await youtube_imports.delete_youtube_import(12, "job-1") is True
    lookup = next(call for call in connection.calls if call[0] == "fetchrow")
    assert "WHERE job_id = $1 AND user_id = $2 FOR UPDATE" in lookup[1]
    assert lookup[2] == ("job-1", 12)
    delete = next(call for call in connection.calls if call[0] == "execute")
    assert "DELETE FROM yt_import_jobs" in delete[1]
    assert "status = ANY($3::text[])" in delete[1]
    assert delete[2] == ("job-1", 12, list(youtube_imports.FINISHED_IMPORT_STATUSES))


@pytest.mark.asyncio
async def test_delete_missing_import_history_is_idempotent(monkeypatch):
    connection = FakeConnection(job=None)

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)

    assert await youtube_imports.delete_youtube_import(12, "already-deleted") is True
    assert not any(call[0] == "execute" for call in connection.calls)


@pytest.mark.asyncio
async def test_delete_rejects_an_active_import(monkeypatch):
    connection = FakeConnection(job={"status": "running"})

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)

    with pytest.raises(ValueError, match="wait for the import to finish"):
        await youtube_imports.delete_youtube_import(12, "job-1")
    assert not any(call[0] == "execute" for call in connection.calls)


@pytest.mark.asyncio
async def test_claim_and_section_lease_refresh_are_token_checked(monkeypatch):
    connection = FakeConnection()

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    item = {
        "id": 9,
        "stage": "resolve",
        "claim_token": "item-owner",
        "user_id": 12,
        "worker_section": 3,
        "worker_lease_token": "section-owner",
    }

    assert await youtube_imports._refresh_claim_lease(item) is True
    assert youtube_imports.CLAIM_LEASE_REFRESH_SECONDS < youtube_imports.CLAIM_STALE_AFTER_MINUTES * 60
    updates = [call for call in connection.calls if call[0] == "execute"]
    renewal = next(call for call in connection.calls if call[0] == "fetchval")
    assert "WHERE id = $1 AND status = $2 AND claim_token = $3" in updates[0][1]
    assert updates[0][2] == (9, "resolving", "item-owner")
    assert "owner_token = $3" in renewal[1]
    assert "lease_until > now()" in renewal[1]
    assert renewal[2] == (12, 3, "section-owner", youtube_imports.IMPORT_SECTION_LEASE_SECONDS)


@pytest.mark.asyncio
async def test_claim_heartbeat_survives_item_completion_race(monkeypatch):
    connection = FakeConnection(update_result="UPDATE 0")

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(youtube_imports, "get_pool", get_pool)
    item = {
        "id": 9, "stage": "process", "claim_token": "finished-item",
        "user_id": 12, "worker_section": 3, "worker_lease_token": "section-owner",
    }

    assert await youtube_imports._refresh_claim_lease(item) is True


@pytest.mark.asyncio
async def test_claim_heartbeat_database_error_fails_closed(monkeypatch):
    sleeps = []

    async def immediate_sleep(seconds):
        sleeps.append(seconds)

    async def failed_refresh(_item):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(youtube_imports.asyncio, "sleep", immediate_sleep)
    monkeypatch.setattr(youtube_imports, "_refresh_claim_lease", failed_refresh)

    await youtube_imports._keep_claim_alive({"id": 9})

    assert sleeps == [youtube_imports.CLAIM_LEASE_REFRESH_SECONDS]


@pytest.mark.asyncio
async def test_lost_section_lease_cancels_active_source_work(monkeypatch):
    started = asyncio.Event()
    cancelled = asyncio.Event()
    blocked = asyncio.Event()

    async def lease_lost(_item):
        await asyncio.sleep(0)

    async def resolve(_item, _key):
        started.set()
        try:
            await blocked.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(youtube_imports, "_keep_claim_alive", lease_lost)
    monkeypatch.setattr(youtube_imports, "_resolve_claim", resolve)

    with pytest.raises(RuntimeError, match="lost the durable"):
        await youtube_imports._run_claim_with_lease({"stage": "resolve"}, b"key", object())

    assert started.is_set() and cancelled.is_set()


@pytest.mark.asyncio
async def test_each_user_gets_exactly_eight_section_workers(monkeypatch):
    started = []
    never = asyncio.Event()

    async def worker(user_id, section):
        started.append((user_id, section))
        await never.wait()

    monkeypatch.setattr(youtube_imports, "_run_user_import_worker", worker)
    tasks = youtube_imports._ensure_user_import_workers(12)
    await asyncio.sleep(0)

    assert len(tasks) == 8
    assert sorted(started) == [(12, section) for section in range(8)]
    await youtube_imports.stop_youtube_import_workers()


@pytest.mark.asyncio
@pytest.mark.parametrize("claim_error", [None, RuntimeError("database error")])
async def test_user_worker_releases_section_lease_on_empty_queue_or_error(
    monkeypatch, claim_error
):
    released = []

    async def vault_key(_user_id):
        return b"key"

    async def acquire(_user_id, _section):
        return "section-owner"

    async def release(_user_id, _section, token):
        released.append(token)

    async def claim(_user_id, _section, _token):
        if claim_error is not None:
            raise claim_error
        return None

    async def sleep(_seconds):
        raise asyncio.CancelledError()

    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "_acquire_worker_section_lease", acquire)
    monkeypatch.setattr(youtube_imports, "_release_worker_section_lease", release)
    monkeypatch.setattr(youtube_imports, "_claim_user_import_item", claim)
    monkeypatch.setattr(youtube_imports, "_worker_sleep", sleep)

    with pytest.raises(asyncio.CancelledError):
        await youtube_imports._run_user_import_worker(12, 0)

    assert released == ["section-owner"]


@pytest.mark.asyncio
async def test_user_worker_backoff_grows_across_repeated_claim_faults(monkeypatch):
    sleeps = []

    async def vault_key(_user_id):
        return b"key"

    async def acquire(_user_id, _section):
        return "section-owner"

    async def release(_user_id, _section, _token):
        return None

    async def claim(_user_id, _section, _token):
        raise RuntimeError("database unavailable")

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise asyncio.CancelledError()

    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "_acquire_worker_section_lease", acquire)
    monkeypatch.setattr(youtube_imports, "_release_worker_section_lease", release)
    monkeypatch.setattr(youtube_imports, "_claim_user_import_item", claim)
    monkeypatch.setattr(youtube_imports, "_worker_sleep", sleep)
    monkeypatch.setattr(youtube_imports.random, "uniform", lambda low, high: high)

    with pytest.raises(asyncio.CancelledError):
        await youtube_imports._run_user_import_worker(12, 0)

    assert sleeps == [2.4, 4.8]


@pytest.mark.asyncio
async def test_user_worker_awaits_one_second_after_a_completed_source(monkeypatch):
    item = {"stage": "process", "id": 1, "claim_token": "claim"}
    sleeps = []

    async def vault_key(_user_id):
        return b"key"

    async def acquire(_user_id, _section):
        return "section-owner"

    async def release(_user_id, _section, token):
        assert token == "section-owner"

    async def claim(_user_id, _section, token):
        assert token == "section-owner"
        return item

    async def run_claim(_item, _key, _store):
        return None

    async def sleep(seconds):
        sleeps.append(seconds)
        raise asyncio.CancelledError()

    monkeypatch.setattr(youtube_imports.vault, "get", vault_key)
    monkeypatch.setattr(youtube_imports, "_acquire_worker_section_lease", acquire)
    monkeypatch.setattr(youtube_imports, "_release_worker_section_lease", release)
    monkeypatch.setattr(youtube_imports, "_claim_user_import_item", claim)
    monkeypatch.setattr(youtube_imports, "_run_claim_with_lease", run_claim)
    monkeypatch.setattr(youtube_imports, "_worker_sleep", sleep)

    with pytest.raises(asyncio.CancelledError):
        await youtube_imports._run_user_import_worker(12, 0)

    assert sleeps == [1.0]
