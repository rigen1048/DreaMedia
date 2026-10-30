"""DreaMedia app entry — uv run -m App.main (owner's -m standard).

Lifespan: migrate schema, seed admin settings, start both managers as
background tasks (yt + ani). Serves: REST (Feed/Access per plugin, auth,
admin), children GraphQL (/graphql/yt, /graphql/ani), and the supergraph
(/graphql).
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from strawberry.fastapi import GraphQLRouter

from Admin import scheduler, settings
from Admin.router import router as admin_router
from Auth.router import router as auth_router
from Database import db
from Graphql.children import ani_schema, yt_schema
from Graphql.supergraph import supergraph_schema
from Orchestrator.Ani import manager as ani_manager
from Orchestrator.Ani.Access.router import router as ani_access_router
from Orchestrator.Ani.Feed.router import router as ani_feed_router
from Orchestrator.Yt import manager as yt_manager
from Orchestrator.Yt.Access.router import router as yt_access_router
from Orchestrator.Yt.Feed.router import router as yt_feed_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.migrate()
    await settings.seed_defaults()
    managers = [
        asyncio.create_task(yt_manager.run_forever()),
        asyncio.create_task(ani_manager.run_forever()),
        asyncio.create_task(scheduler.run_forever()),
    ]
    yield
    for task in managers:
        task.cancel()
    await asyncio.gather(*managers, return_exceptions=True)
    await db.close()


app = FastAPI(title="DreaMedia", version="0.1.0", lifespan=lifespan)

app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(yt_feed_router)
app.include_router(yt_access_router)
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


@app.get("/health")
async def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("App.main:app", host="127.0.0.1", port=8000, reload=False)
