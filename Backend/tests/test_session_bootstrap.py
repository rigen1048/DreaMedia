from types import SimpleNamespace

import pytest

from Graphql.supergraph import supergraph_schema


@pytest.mark.asyncio
async def test_viewer_probe_returns_null_without_auth_or_protected_resolvers():
    request = SimpleNamespace(cookies={})
    result = await supergraph_schema.execute(
        "query { viewer { id username role } }",
        context_value={"request": request},
    )

    assert result.errors is None
    assert result.data == {"viewer": None}


@pytest.mark.asyncio
async def test_viewer_probe_returns_null_for_expired_cookie(monkeypatch):
    from Auth import auth

    async def expired_session(_token):
        return None

    monkeypatch.setattr(auth, "resolve_session", expired_session)
    request = SimpleNamespace(cookies={"dreamedia": "expired-session"})
    result = await supergraph_schema.execute(
        "query { viewer { id username role } }",
        context_value={"request": request},
    )

    assert result.errors is None
    assert result.data == {"viewer": None}
