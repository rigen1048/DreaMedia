"""Extension GraphQL API (ext v2 phase 2): the single token-authed lane.

Mounted at /ext/graphql. Deliberately small and stable — the extension is
released software that can't ride internal refactors, exactly like the REST
/ext router it replaces. HTTP POST carries the token in X-DreaMedia-Token;
the websocket (graphql-transport-ws) carries it in connection_init's
payload, which strawberry drops into context["connection_params"].
"""
from __future__ import annotations

from typing import List, Optional

import strawberry
from returns.result import Failure
from strawberry.types import Info

from Extension import anchor, live
from Extension.tokens import user_for_token


async def ext_context():
    # The router's merged context always carries "request" (Request for
    # HTTP, WebSocket for the socket). The ws token arrives in
    # connection_init AFTER the context is created, so strawberry merges it
    # into this dict as "connection_params" — read it lazily in _ext_uid.
    return {}


async def _ext_uid(info: Info) -> int:
    ctx = info.context
    params = ctx.get("connection_params") or {}
    token = params.get("token", "")
    if not token:
        req = ctx.get("request")
        headers = getattr(req, "headers", None) or {}
        token = headers.get("X-DreaMedia-Token", "")
    user_id = await user_for_token(token)
    if user_id is None:
        raise ValueError("invalid extension token")
    return user_id


def _unwrap(result, fallback: str = "Request failed"):
    if isinstance(result, Failure):
        raise ValueError(result.failure() or fallback)
    return result.unwrap()


@strawberry.type
class ExtQuery:
    @strawberry.field
    async def ext_ping(self, info: Info) -> bool:
        await _ext_uid(info)
        return True


@strawberry.type
class AnchorMatch:
    entry_id: int
    season: Optional[int]       # parsed from the page; None = not stated there
    episode: Optional[int]      # parsed (absolute numbers resolved via the chain)
    cursor_season: Optional[int]    # fallbacks for the binding
    cursor_episode: Optional[int]


@strawberry.type
class ExtMutation:
    @strawberry.field
    async def anchor_match(
        self, info: Info, candidates: List[str], page_url: str = ""
    ) -> Optional[AnchorMatch]:
        """Phase 3: 'what anime is this page?' — null when nothing tracked
        matches. page_url rides along for phase 5 watch-site learning."""
        match = _unwrap(await anchor.anchor_match(await _ext_uid(info), candidates, page_url))
        return AnchorMatch(**match) if match else None

    @strawberry.field
    async def live_progress(
        self, info: Info, entry_id: int, season: int, episode: int, position_seconds: int
    ) -> bool:
        """Live-session upsert — the heartbeat while watching."""
        _unwrap(await live.upsert_position(
            await _ext_uid(info), entry_id, season, episode, position_seconds
        ))
        return True

    @strawberry.field
    async def live_end(
        self, info: Info, entry_id: int, season: int, episode: int, position_seconds: int
    ) -> bool:
        """Pause/ended: merge the final position into the real cursor."""
        _unwrap(await live.end_session(
            await _ext_uid(info), entry_id, season, episode, position_seconds
        ))
        return True


ext_schema = strawberry.Schema(query=ExtQuery, mutation=ExtMutation)
