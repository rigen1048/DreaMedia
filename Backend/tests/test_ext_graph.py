"""Token-lane GraphQL contracts used by the browser extension."""
from types import SimpleNamespace

import pytest
from returns.result import Success

from Graphql import ext_graph
from Orchestrator.Yt.Fetch import convert


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
            "words": None, "withhold": 3, "domain": "Media",
            "subdomain": "Animation", "logo": None,
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
    assert "importYoutubeChannels" in schema


@pytest.mark.asyncio
async def test_extension_batch_import_validates_and_skips_duplicates(monkeypatch, extension_info):
    store = FakeYtStore()
    async def user_id(_info):
        return 12

    monkeypatch.setattr(ext_graph, "_ext_uid", user_id)
    monkeypatch.setattr(ext_graph, "_yt", store)
    monkeypatch.setattr(
        convert,
        "resolve_channel",
        lambda link: Success(SimpleNamespace(
            rss_id="UC" + ("x" * 22), name="Example channel",
            url=link, logo=None,
        )),
    )

    result = await ext_graph.ExtMutation().import_youtube_channels(
        extension_info,
        links=[
            "https://www.youtube.com/@example",
            "https://www.youtube.com/@example/",
            "https://not-youtube.example/channel/UC" + ("x" * 22),
        ],
    )

    assert result.requested == 3
    assert result.added == 1
    assert result.skipped == 1
    assert len(result.errors) == 1
    assert len(store.calls) == 1
    assert store.calls[0][2]["skip_existing"] is True


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
    from strawberry.fastapi import GraphQLRouter

    calls = []

    async def user_for_token(token):
        calls.append(token)
        return 23 if token == "probe-token" else None

    monkeypatch.setattr(ext_graph, "user_for_token", user_for_token)
    app = FastAPI()
    app.include_router(
        GraphQLRouter(ext_graph.ext_schema, context_getter=ext_graph.ext_context),
        prefix="/ext/graphql",
    )

    with TestClient(app) as client:
        with client.websocket_connect(
            "/ext/graphql", subprotocols=["graphql-transport-ws"]
        ) as websocket:
            websocket.send_json({"type": "connection_init", "payload": {"token": "probe-token"}})
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

    assert calls == ["probe-token"]


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
