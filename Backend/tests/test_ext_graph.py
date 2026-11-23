"""Token-lane GraphQL contracts used by the browser extension."""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from returns.result import Success

from Extension import store as ext_store
from Graphql import ext_graph
from Media.Yt.Fetch import convert


class FakeYtStore:
    def __init__(self):
        self.calls = []

    async def domains_tree(self, user_id):
        self.calls.append(("domains_tree", user_id))
        return {
            "domains": [
                {
                    "id": 7,
                    "name": "Media",
                    "subdomains": [{"id": 9, "name": "Animation"}],
                }
            ]
        }

    async def add_tracking(self, *args, **kwargs):
        self.calls.append(("add_tracking", args, kwargs))
        return Success(41)

    async def switch_mode(self, *args, **kwargs):
        self.calls.append(("switch_mode", args, kwargs))
        return Success({"id": 41, "kind": "withhold"})

    async def assign_category(self, *args, **kwargs):
        self.calls.append(("assign_category", args, kwargs))
        return Success({"id": 41})

    async def add_extension_subscription(self, *args, **kwargs):
        self.calls.append(("add_extension_subscription", args, kwargs))
        return Success({"channel_id": 41, "created": True})


@pytest.fixture
def extension_info():
    return SimpleNamespace(context={})


@pytest.mark.asyncio
async def test_anchor_match_graphql_hints_are_optional_and_forwarded(monkeypatch):
    calls = []

    async def user_id(_info):
        return 12

    async def match(user, candidates, page_url="", season_hint=None, episode_hint=None):
        calls.append((user, candidates, page_url, season_hint, episode_hint))
        return Success({
            "entry_id": 22,
            "title": "One Piece",
            "season": season_hint or 1,
            "episode": episode_hint or 185,
            "cursor_season": 1,
            "cursor_episode": 184,
            "blocked": False,
            "reason": None,
        })

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph.anchor, "anchor_match", match)

    # An extension build without hint variables remains schema-compatible.
    legacy = await ext_graph.ext_schema.execute(
        'mutation { anchorMatch(candidates: ["One Piece"], pageUrl: "https://anime.example/watch/21") '
        '{ entryId title season episode } }'
    )
    assert legacy.errors is None
    assert legacy.data["anchorMatch"]["episode"] == 185
    assert calls[-1] == (12, ["One Piece"], "https://anime.example/watch/21", None, None)

    hinted = await ext_graph.ext_schema.execute(
        'mutation { anchorMatch(candidates: ["One Piece"], pageUrl: "https://anime.example/watch/21", '
        'seasonHint: 2, episodeHint: 29) { entryId title season episode } }'
    )
    assert hinted.errors is None
    assert hinted.data["anchorMatch"] == {
        "entryId": 22, "title": "One Piece", "season": 2, "episode": 29,
    }
    assert calls[-1] == (12, ["One Piece"], "https://anime.example/watch/21", 2, 29)


@pytest.mark.asyncio
async def test_extension_category_query_returns_parent_child_combinations(monkeypatch, extension_info):
    store = FakeYtStore()
    async def user_id(_info):
        return 12

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "_yt", store)

    rows = await ext_graph.ExtQuery().yt_categories(extension_info)

    assert [(row.id, row.name) for row in rows] == [(7, "Media")]
    assert [(row.id, row.name) for row in rows[0].subdomains] == [(9, "Animation")]
    assert store.calls == [("domains_tree", 12)]


@pytest.mark.asyncio
async def test_extension_domains_syncs_enabled_and_paused_sites(monkeypatch, extension_info):
    class FakeDomains:
        def __init__(self):
            self.calls = []

        async def ensure_default_youtube(self, user_id):
            self.calls.append(("ensure_default_youtube", user_id))
            return Success(True)

        async def list_domains(self, user_id, enabled_only=False):
            self.calls.append(("list_domains", user_id, enabled_only))
            return [
                {"id": 1, "domain": "youtube.com", "media": "yt", "enabled": True},
                {"id": 2, "domain": "example.com", "media": "ani", "enabled": False},
            ]

    domains = FakeDomains()

    async def user_id(_info):
        return 12

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "_domains", domains)

    rows = await ext_graph.ExtQuery().domains(extension_info)

    assert [(row.domain, row.media, row.enabled) for row in rows] == [
        ("youtube.com", "yt", True), ("example.com", "ani", False),
    ]
    assert domains.calls == [
        ("ensure_default_youtube", 12), ("list_domains", 12, False),
    ]


@pytest.mark.asyncio
async def test_default_youtube_seed_is_applied_only_once(monkeypatch):
    class FakeConnection:
        def __init__(self):
            self.seeded = False
            self.inserts = []

        @asynccontextmanager
        async def transaction(self):
            yield

        async def fetchval(self, _query, user_id):
            if self.seeded:
                return None
            self.seeded = True
            return user_id

        async def execute(self, query, *args):
            self.inserts.append((query, args))

    class FakePool:
        def __init__(self, connection):
            self.connection = connection

        @asynccontextmanager
        async def acquire(self):
            yield self.connection

    connection = FakeConnection()

    async def vault_key(_user_id):
        return b"vault-key"

    async def get_pool():
        return FakePool(connection)

    monkeypatch.setattr(ext_store.vault, "get", vault_key)
    monkeypatch.setattr(ext_store, "get_pool", get_pool)
    monkeypatch.setattr(ext_store, "encrypt", lambda _key, value: f"enc:{value}".encode())
    monkeypatch.setattr(ext_store, "index_hash", lambda _key, value: f"hash:{value}".encode())

    store = ext_store.ExtDomainStore()
    first = await store.ensure_default_youtube(12)
    second = await store.ensure_default_youtube(12)

    assert isinstance(first, Success) and first.unwrap() is True
    assert isinstance(second, Success) and second.unwrap() is False
    assert len(connection.inserts) == 1
    query, args = connection.inserts[0]
    assert "'yt'" in query and args == (12, b"enc:youtube.com", b"hash:youtube.com")


@pytest.mark.asyncio
async def test_extension_subscribe_creates_withhold_source_and_category(monkeypatch, extension_info):
    store = FakeYtStore()
    async def user_id(_info):
        return 12

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "_yt", store)
    monkeypatch.setattr(
        convert,
        "resolve_channel",
        lambda _link: Success(SimpleNamespace(
            rss_id="UCextension", name="Example channel",
            url="https://www.youtube.com/@example", logo=None,
        )),
    )

    result = await ext_graph.ExtMutation().subscribe(
        extension_info,
        link="https://www.youtube.com/@example",
        kind="withhold",
        withhold=3,
        domain=" Media ",
        subdomain=" Animation ",
    )

    assert result.ok and result.channel_id == 41
    assert len(store.calls) == 1
    assert store.calls[0] == (
        "add_extension_subscription", (12,), {
            "rss_id": "UCextension", "channel_name": "Example channel",
            "channel_url": "https://www.youtube.com/@example", "kind": "withhold",
            "words": None, "rank": None, "withhold": 3, "domain": "Media",
            "subdomain": "Animation", "logo": None, "skip_existing": False,
        }
    )


@pytest.mark.asyncio
async def test_extension_subscribe_rejects_missing_withhold_threshold(monkeypatch, extension_info):
    async def user_id(_info):
        return 12

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    with pytest.raises(ValueError, match="withhold threshold must be >= 1"):
        await ext_graph.ExtMutation().subscribe(
            extension_info, link="https://www.youtube.com/@example", kind="withhold"
        )


@pytest.mark.asyncio
async def test_extension_subscribe_rejects_partial_category_pair(monkeypatch, extension_info):
    async def user_id(_info):
        return 12

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    with pytest.raises(ValueError, match="choose both a domain and subdomain"):
        await ext_graph.ExtMutation().subscribe(
            extension_info,
            link="https://www.youtube.com/@example",
            kind="tracking",
            domain="Media",
        )


def test_extension_schema_exposes_category_and_withhold_contract():
    schema = ext_graph.ext_schema.as_str()
    assert "ytCategories" in schema
    assert "withhold: Int" in schema
    assert "domain: String" in schema
    assert "subdomain: String" in schema
    assert "eventTimeMs: String" in schema
    assert "importYoutubeChannels" not in schema
    assert "startYoutubeImport" in schema
    assert "youtubeImportJob" in schema
    assert "retryYoutubeImport" in schema
    assert "failedItems" in schema
    assert "retryable: Boolean!" in schema
    assert "resolved: Int!" in schema


@pytest.mark.asyncio
async def test_bulk_start_returns_queued_job_without_resolving_channels(monkeypatch, extension_info):
    calls = []

    async def user_id(_info):
        return 12

    async def enqueue(user, links, **options):
        calls.append((user, links, options))
        return {
            "job_id": "job-123", "status": "queued", "requested": 2,
            "processed": 0, "resolved": 0, "added": 0, "skipped": 0, "failed": 0,
        }

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "enqueue_youtube_import", enqueue)

    result = await ext_graph.ExtMutation().start_youtube_import(
        extension_info,
        links=["https://youtube.com/@one", "https://youtube.com/@two"],
        kind="wordscan",
        words=["trailer"],
        domain="Media",
        subdomain="Animation",
    )

    assert result.job_id == "job-123" and result.status == "queued"
    assert result.requested == 2 and result.processed == 0
    assert result.resolved == 0
    assert calls == [(
        12,
        ["https://youtube.com/@one", "https://youtube.com/@two"],
        {
            "kind": "wordscan", "words": ["trailer"], "rank": None,
            "withhold": None, "domain": "Media", "subdomain": "Animation",
        },
    )]


@pytest.mark.asyncio
async def test_import_progress_query_uses_authenticated_owner(monkeypatch, extension_info):
    calls = []

    async def user_id(_info):
        return 12

    async def get_status(owner, job_id):
        calls.append((owner, job_id))
        return {
            "job_id": job_id, "status": "partial", "requested": 4,
            "processed": 4, "resolved": 3, "added": 1, "skipped": 1, "failed": 1,
            "errors": ["timed out"],
            "failed_items": [{
                "link": "https://youtube.com/@channel", "error": "timed out", "retryable": True,
            }],
        }

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "get_youtube_import_status", get_status)

    result = await ext_graph.ext_schema.execute(
        'query { youtubeImportJob(jobId: "job-123") { jobId status processed failed errors '
        'failedItems { link error retryable } } }'
    )

    assert calls == [(12, "job-123")]
    assert result.errors is None
    assert result.data["youtubeImportJob"]["jobId"] == "job-123"
    assert result.data["youtubeImportJob"]["processed"] == 4
    assert result.data["youtubeImportJob"]["failedItems"] == [{
        "link": "https://youtube.com/@channel", "error": "timed out", "retryable": True,
    }]


@pytest.mark.asyncio
async def test_retry_import_mutation_uses_authenticated_owner_and_returns_new_job(monkeypatch, extension_info):
    calls = []

    async def user_id(_info):
        return 12

    async def retry(owner, job_id):
        calls.append((owner, job_id))
        return {
            "job_id": "retry-456", "status": "queued", "requested": 1,
            "processed": 0, "resolved": 0, "added": 0, "skipped": 0, "failed": 0,
        }

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "retry_youtube_import_job", retry)

    result = await ext_graph.ext_schema.execute(
        'mutation { retryYoutubeImport(jobId: "failed-123") { jobId status requested } }'
    )

    assert calls == [(12, "failed-123")]
    assert result.errors is None
    assert result.data["retryYoutubeImport"] == {
        "jobId": "retry-456", "status": "queued", "requested": 1,
    }


@pytest.mark.asyncio
async def test_import_progress_query_returns_null_for_unknown_or_other_owner(monkeypatch, extension_info):
    async def user_id(_info):
        return 12

    async def get_status(owner, job_id):
        assert owner == 12 and job_id == "hidden-job"
        return None

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "get_youtube_import_status", get_status)

    assert await ext_graph.ExtQuery().youtube_import_job(extension_info, "hidden-job") is None


@pytest.mark.asyncio
async def test_websocket_ext_ping_probe_authenticates_connection_params(monkeypatch):
    async def user_for_token(token):
        return 23 if token == "probe-token" else None

    monkeypatch.setattr(ext_graph, "user_for_token", user_for_token)

    accepted = await ext_graph.ext_schema.execute(
        "query { extPing }", context_value={"connection_params": {"token": "probe-token"}}
    )
    assert accepted.errors is None
    assert accepted.data == {"extPing": True}

    rejected = await ext_graph.ext_schema.execute(
        "query { extPing }", context_value={"connection_params": {"token": "bad-token"}}
    )
    assert rejected.errors


@pytest.mark.asyncio
async def test_extension_api_rejects_http_header_auth(monkeypatch):
    async def user_for_token(token):
        return 23 if token == "probe-token" else None

    monkeypatch.setattr(ext_graph, "user_for_token", user_for_token)
    result = await ext_graph.ext_schema.execute(
        "query { extPing }",
        context_value={"request": SimpleNamespace(headers={"X-DreaMedia-Token": "probe-token"})},
    )

    assert result.errors
    assert "WebSocket authentication" in result.errors[0].message


@pytest.mark.asyncio
async def test_extension_identity_is_validated_once_per_socket_context(monkeypatch):
    calls = []

    async def user_for_token(token):
        calls.append(token)
        return 23

    monkeypatch.setattr(ext_graph, "user_for_token", user_for_token)
    info = SimpleNamespace(context={"connection_params": {"token": "probe-token"}})

    assert await ext_graph._ext_uid(info) == 23
    assert await ext_graph._ext_uid(info) == 23
    assert calls == ["probe-token"]


def test_websocket_route_authenticates_once_and_answers_client_ping(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from Extension.ws_router import ExtensionGraphQLRouter

    calls = []

    async def user_for_token(token):
        calls.append(token)
        return 23 if token == "dm_probe-token" else None

    monkeypatch.setattr(ext_graph, "user_for_token", user_for_token)
    app = FastAPI()
    app.include_router(
        ExtensionGraphQLRouter(
            ext_graph.ext_schema,
            context_getter=ext_graph.ext_context,
            token_validator=user_for_token,
        ),
        prefix="/ext/graphql",
    )

    with TestClient(app) as client:
        with client.websocket_connect(
            "/ext/graphql",
            subprotocols=["graphql-transport-ws"],
            headers={"Origin": "chrome-extension://iemcebbhpkagkchbdcfbbomcnjiodlhe"},
        ) as websocket:
            websocket.send_json({"type": "connection_init", "payload": {"token": "dm_probe-token"}})
            assert websocket.receive_json() == {"type": "connection_ack"}

            websocket.send_json({"type": "ping"})
            assert websocket.receive_json() == {"type": "pong"}

            for operation_id in ("auth", "next"):
                websocket.send_json({
                    "id": operation_id,
                    "type": "subscribe",
                    "payload": {"query": "query { extPing }", "variables": {}},
                })
                result = websocket.receive_json()
                assert result["id"] == operation_id
                assert result["type"] == "next"
                assert result["payload"]["data"] == {"extPing": True}
                assert websocket.receive_json() == {"id": operation_id, "type": "complete"}

        with client.websocket_connect(
            "/ext/graphql",
            subprotocols=["graphql-transport-ws"],
            headers={"Origin": "chrome-extension://iemcebbhpkagkchbdcfbbomcnjiodlhe"},
        ) as websocket:
            websocket.send_json({"type": "connection_init", "payload": {"token": "dm_bad-token"}})
            with pytest.raises(WebSocketDisconnect) as rejected:
                websocket.receive_json()
            assert rejected.value.code == 4403

        with pytest.raises(WebSocketDisconnect) as rejected_origin:
            with client.websocket_connect(
                "/ext/graphql",
                subprotocols=["graphql-transport-ws"],
                headers={"Origin": "https://attacker.example"},
            ):
                pytest.fail("unrelated Origin must be rejected before WebSocket acceptance")
        assert rejected_origin.value.code == 1008

    assert calls == ["dm_probe-token", "dm_bad-token"]


def test_extension_websocket_origin_policy_is_narrow():
    from Extension.ws_router import is_browser_extension_origin

    assert is_browser_extension_origin(
        "chrome-extension://iemcebbhpkagkchbdcfbbomcnjiodlhe"
    )
    assert is_browser_extension_origin("moz-extension://test-addon-id")
    assert not is_browser_extension_origin("https://example.com")
    assert not is_browser_extension_origin("chrome-extension://test-addon-id/path")


@pytest.mark.asyncio
async def test_extension_card_add_counts_only_new_items(monkeypatch, extension_info):
    class FakeCards:
        async def add_item_detailed(self, _user_id, _card_id, _video_id, url, _title, _thumbnail):
            return Success({"id": 31, "added": url.endswith("new")})

    async def user_id(_info):
        return 12

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "_cards", FakeCards())
    monkeypatch.setattr(
        convert,
        "resolve_video",
        lambda link: Success(SimpleNamespace(video_id=link, url=link, title="Video", thumbnail=None)),
    )

    result = await ext_graph.ExtMutation().add_card_items(
        extension_info, card_id=5, links=["https://youtu.be/new", "https://youtu.be/existing"]
    )

    assert result.added == 1 and result.requested == 2 and result.errors == []
