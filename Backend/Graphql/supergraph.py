"""Supergraph (D25): the single GraphQL endpoint the frontend talks to.

Merges the yt/ani feature schemas with auth (viewer/login/signup/logout)
and the backend-message history. Session cookies are written through
request.state and applied by the HTTP middleware in App.main — so login is
a normal GraphQL mutation, not a side-channel REST route.
"""
from __future__ import annotations

import json
from typing import List, Optional

import strawberry
from returns.result import Failure
from strawberry.types import Info

from Auth import auth
from Database.pg_store import PgStore
from Graphql.admin import AdminMutation, AdminQuery
from Graphql.children import AniMutation, AniQuery, BackendMessage, Viewer, YtMutation, YtQuery

_yt = PgStore()


async def _viewer(info: Info) -> Optional[Viewer]:
    request = info.context["request"]
    token = request.cookies.get("dreamedia")
    if not token:
        return None
    user_id = await auth.resolve_session(token)
    if user_id is None:
        return None
    from Database.db import get_pool

    pool = await get_pool()
    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT id, username, role FROM users WHERE id = $1", user_id
        )
    if row is None:
        return None
    return Viewer(id=row["id"], username=row["username"], role=row["role"])


@strawberry.type
class AuthQuery:
    @strawberry.field
    async def viewer(self, info: Info) -> Optional[Viewer]:
        return await _viewer(info)

    @strawberry.field
    async def backend_messages(self, info: Info, limit: int = 100) -> List[BackendMessage]:
        """Durable history of backend-originated messages. The bell itself is
        fed by the frontend's REST receiver; this query is the audit/hydration
        lane and is never mixed with feed rows."""
        viewer = await _viewer(info)
        if viewer is None:
            return []
        rows = await _yt.messages(viewer.id, limit)
        result = []
        for r in rows:
            payload = r.get("payload") or {}
            record = payload if isinstance(payload, dict) else {}
            title = record.get("title") or record.get("channel") or r["kind"]
            message = record.get("message") or ""
            if not message:
                if record.get("channel"):
                    message = f"{record['channel']} · {record.get('mode', r['kind'])}"
                elif record.get("season"):
                    message = f"Season {record['season']}"
            result.append(
                BackendMessage(
                    id=r["id"], media=r["media"], kind=r["kind"], title=str(title),
                    message=str(message), level=str(record.get("level") or "info"),
                    url=record.get("url"), created_at=r["created_at"],
                    seen=r["seen"], pushed=r["pushed"],
                    payload=json.dumps(record.get("payload", record), default=str),
                )
            )
        return result


@strawberry.type
class AuthMutation:
    @strawberry.field
    async def login(self, info: Info, username: str, password: str) -> Viewer:
        result = await auth.login(username.strip(), password)
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        data = result.unwrap()
        info.context["request"].state.auth_cookie = data["token"]
        return Viewer(id=data["user_id"], username=data["username"], role=data["role"])

    @strawberry.field
    async def signup(self, info: Info, username: str, password: str) -> Viewer:
        result = await auth.signup(username.strip(), password)
        if isinstance(result, Failure):
            raise ValueError(result.failure())
        data = result.unwrap()
        info.context["request"].state.auth_cookie = data["token"]
        return Viewer(id=data["user_id"], username=data["username"], role=data["role"])

    @strawberry.field
    async def logout(self, info: Info) -> bool:
        request = info.context["request"]
        token = request.cookies.get("dreamedia")
        if token:
            await auth.logout(token)
        request.state.clear_auth_cookie = True
        return True

    @strawberry.field
    async def messages_seen(self, info: Info, ids: List[int], seen: bool = True) -> int:
        viewer = await _viewer(info)
        if viewer is None:
            return 0
        if not ids:
            return 0
        from Database.db import get_pool

        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE notifications SET seen = $3 WHERE user_id = $1 AND id = ANY($2)",
                viewer.id, ids, seen,
            )
        return int(result.split()[-1])


@strawberry.type
class Query(YtQuery, AniQuery, AuthQuery, AdminQuery):
    pass


@strawberry.type
class Mutation(YtMutation, AniMutation, AuthMutation, AdminMutation):
    pass


supergraph_schema = strawberry.Schema(query=Query, mutation=Mutation)
