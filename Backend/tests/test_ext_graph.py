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
    assert store.calls[0][0] == "add_tracking"
    assert store.calls[0][2]["kind"] == "tracking"
    assert store.calls[1] == (
        "switch_mode", (12, 41, "withhold"), {"words": None, "withhold": 3}
    )
    assert store.calls[2] == (
        "assign_category", (12, 41, "Media", "Animation"), {}
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
