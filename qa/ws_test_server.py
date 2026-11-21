"""Isolated Uvicorn server for the extension GraphQL WebSocket protocol.

Run from the repository root:
    cd Backend
    uv run uvicorn ws_test_server:app --app-dir ../qa --host 127.0.0.1 --port 8765

This uses the production ExtensionGraphQLRouter and a fake in-memory token
validator. It never imports or connects to the production database.
"""
from __future__ import annotations

import os
import secrets

import strawberry
from fastapi import FastAPI
from strawberry.types import Info

from Extension.ws_router import ExtensionGraphQLRouter

TEST_TOKEN = os.environ.get(
    "DREAMEDIA_WS_TEST_TOKEN", "dm_local_test_token_not_for_production"
)


async def validate_test_token(token: str) -> int | None:
    if not token.startswith("dm_") or not secrets.compare_digest(token, TEST_TOKEN):
        return None
    return 1


async def empty_context() -> dict[str, object]:
    return {}


@strawberry.type
class Query:
    @strawberry.field
    def ext_ping(self, info: Info) -> bool:
        return info.context.get("ext_user_id") == 1


schema = strawberry.Schema(query=Query)
app = FastAPI()
app.include_router(
    ExtensionGraphQLRouter(
        schema,
        context_getter=empty_context,
        token_validator=validate_test_token,
    ),
    prefix="/ext/graphql",
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "mode": "isolated-websocket-test"}
