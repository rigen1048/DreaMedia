"""DreaMedia app entry — uv run -m App.main (owner's -m standard).

Lifespan: migrate schema, seed admin settings, start both managers as
background tasks (yt + ani). Serves: REST (Feed/Access per plugin, auth,
admin), children GraphQL (/graphql/yt, /graphql/ani), and the supergraph
(/graphql).
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import Utility.env  # noqa: F401 — loads the root .env before anything else

from fastapi import FastAPI
from strawberry.fastapi import GraphQLRouter

from Admin import scheduler, settings
from Admin.router import router as admin_router
from Auth.notify_router import router as notifications_router
from Auth.router import router as auth_router
from Database import db
from Graphql.children import ani_schema, yt_schema
from Graphql.supergraph import supergraph_schema
from Orchestrator.Ani import manager as ani_manager
from Orchestrator.Ani.Access.router import router as ani_access_router
from Orchestrator.Ani.Feed.router import router as ani_feed_router
from Extension import live as ext_live
from Extension.tokens import user_for_token
from Extension.youtube_imports import run_youtube_import_worker
from Extension.ws_router import ExtensionGraphQLRouter
from Graphql.ext_graph import ext_context, ext_schema
from Orchestrator.Yt import manager as yt_manager
from Orchestrator.Yt.Access.cards_router import router as yt_cards_router
from Orchestrator.Yt.Access.router import router as yt_access_router
from Orchestrator.Yt.Feed.router import router as yt_feed_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Multi-worker ready (Phase 1+2): sessions/restore-gate in the DB,
    # managers leader-elected, sticky cookie routing keeps vault + gates
    # coherent per user. One worker per container; scale by containers.
    try:
        await db.migrate()
    except Exception as exc:
        raise RuntimeError(
            "Database connection/migration failed. Checklist: "
            "(1) root .env exists with DREAMEDIA_PG_PASSWORD, "
            "(2) the password matches the password the Postgres volume was "
            "INITIALIZED with (POSTGRES_PASSWORD only applies on first init — "
            "changing .env later does nothing; use 'docker compose down -v' "
            "for a fresh volume), "
            "(3) Postgres is reachable at the DSN host:port. "
            f"Original error: {exc}"
        ) from exc
    await settings.seed_defaults()
    # Ext v2 phase 2: leftover live-session rows mean an unclean shutdown —
    # merge them into cursors so no watched position is ever lost.
    await ext_live.sweep_all()
    managers = [
        asyncio.create_task(yt_manager.run_forever()),
        asyncio.create_task(ani_manager.run_forever()),
        asyncio.create_task(scheduler.run_forever()),
        *(asyncio.create_task(run_youtube_import_worker()) for _ in range(4)),
    ]
    yield
    for task in managers:
        task.cancel()
    await asyncio.gather(*managers, return_exceptions=True)
    await db.close()


app = FastAPI(title="DreaMedia", version="0.1.0", lifespan=lifespan)

# Extension origin CORS (D55): the background worker uses the WebSocket lane;
# other extension-origin HTTP requests still use these standard CORS headers.
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension|safari-web-extension)://.*$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    allow_credentials=False,
    max_age=600,
)


@app.middleware("http")
async def _session_cookie(request, call_next):
    """GraphQL auth writes request.state.auth_cookie; the cookie itself is
    applied here so login/signup/logout stay ordinary mutations."""
    response = await call_next(request)
    token = getattr(request.state, "auth_cookie", None)
    if token:
        from Config.Hardcoded.limits import SESSION_TTL_SECONDS

        response.set_cookie(
            "dreamedia",
            token,
            max_age=SESSION_TTL_SECONDS,
            httponly=True,
            samesite="lax",
            path="/",
        )
    if getattr(request.state, "clear_auth_cookie", False):
        response.delete_cookie("dreamedia", path="/")
    return response


_restore_gate_cache = {"at": 0.0, "active": False}


@app.middleware("http")
async def _restore_gate(request, call_next):
    """During an admin restore, mutations are refused (503) and reads pass.
    The gate is DB-backed (Phase 1.2) so EVERY worker refuses writes, not
    just the one running the restore. 2s local cache keeps it cheap."""
    import time as _time

    from Admin.restore import restore_in_progress, restore_in_progress_db

    active = restore_in_progress()
    if not active:
        now = _time.time()
        if now - _restore_gate_cache["at"] > 2:
            active = await restore_in_progress_db()
            _restore_gate_cache.update(at=now, active=active)
        else:
            active = _restore_gate_cache["active"]
    if active and request.method not in ("GET", "HEAD", "OPTIONS"):
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=503,
            content={"detail": "restore in progress — try again shortly"},
        )
    return await call_next(request)


app.include_router(auth_router)
app.include_router(notifications_router)
app.include_router(admin_router)
app.include_router(yt_feed_router)
app.include_router(yt_access_router)
app.include_router(yt_cards_router)
app.include_router(ani_feed_router)
app.include_router(ani_access_router)


from fastapi import Request


async def _graphql_context(request: Request):
    return {"request": request}


app.include_router(
    GraphQLRouter(yt_schema, context_getter=_graphql_context), prefix="/graphql/yt"
)
app.include_router(
    GraphQLRouter(ani_schema, context_getter=_graphql_context), prefix="/graphql/ani"
)
app.include_router(
    GraphQLRouter(supergraph_schema, context_getter=_graphql_context), prefix="/graphql"
)
# Ext v2: the extension's own stable schema, authenticated through
# graphql-transport-ws connection_init on this path.
app.include_router(
    ExtensionGraphQLRouter(
        ext_schema, context_getter=ext_context, token_validator=user_for_token
    ),
    prefix="/ext/graphql",
)


@app.get("/health")
async def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("App.main:app", host="127.0.0.1", port=8000, reload=False)
