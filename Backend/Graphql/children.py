"""Children GraphQL schemas (D25) — one per plugin, resolving over the
same service layer the plugin's Feed/Access REST routers expose.

The supergraph (supergraph.py) merges these children. A new plugin =
new child here + its Feed/Access REST dirs (D16).
"""
from __future__ import annotations

import strawberry

from App.deps import current_user_id
from Database.ani_store import AniStore
from Database.pg_store import PgStore

_yt = PgStore()
_ani = AniStore()


async def _uid(info) -> int:
    """Resolve the session cookie to a user_id (same dep as REST)."""
    request = info.context["request"]
    token = request.cookies.get("dreamedia")
    if not token:
        raise PermissionError("not authenticated")
    from Auth import auth

    user_id = await auth.resolve_session(token)
    if user_id is None:
        raise PermissionError("session expired")
    return user_id


# ---------------- Yt child ----------------
@strawberry.type
class YtVideo:
    id: int
    channel_id: int
    title: str
    url: str
    thumbnail: str | None
    published_at: int | None
    seen: bool
    channel: str | None


@strawberry.type
class YtChannel:
    id: int
    name: str | None
    url: str | None
    label: str
    label_reason: str | None
    rss_id: str | None
    kind: str | None
    active: bool | None
    rank: str | None
    words: list[str]
    domain: str
    subdomain: str


@strawberry.type
class YtSidebarSubdomain:
    key: str
    name: str
    active: bool


@strawberry.type
class YtSidebarDomain:
    key: str
    name: str
    active: bool
    subdomains: list[YtSidebarSubdomain]


@strawberry.type
class YtQuery:
    @strawberry.field
    async def yt_feed(self, info: strawberry.Info, limit: int = 100) -> list[YtVideo]:
        videos = await _yt.feed(await _uid(info), limit)
        return [YtVideo(**v) for v in videos]

    @strawberry.field
    async def yt_channels(self, info: strawberry.Info, include_blocked: bool = False) -> list[YtChannel]:
        channels = await _yt.channels_view(await _uid(info), include_blocked)
        return [YtChannel(**c) for c in channels]

    @strawberry.field
    async def yt_sidebar(self, info: strawberry.Info) -> list[YtSidebarDomain]:
        data = await _yt.sidebar(await _uid(info))
        return [
            YtSidebarDomain(
                key=d["key"], name=d["name"], active=d["active"],
                subdomains=[
                    YtSidebarSubdomain(key=s["key"], name=s["name"], active=s["active"])
                    for s in d["subdomains"]
                ],
            )
            for d in data["domains"]
        ]


@strawberry.type
class YtMutation:
    @strawberry.field
    async def yt_subscribe(
        self, info: strawberry.Info, kind: str, link: str, channel_name: str, channel_url: str,
        words: list[str] | None = None,
    ) -> bool:
        from returns.result import Success

        result = await _yt.add_tracking(
            await _uid(info), link, channel_name, channel_url, kind=kind, words=words
        )
        return isinstance(result, Success)

    @strawberry.field
    async def yt_set_label(self, info: strawberry.Info, channel_id: int, label: str, reason: str | None = None) -> bool:
        from returns.result import Success

        return isinstance(await _yt.set_label(await _uid(info), channel_id, label, reason), Success)

    @strawberry.field
    async def yt_mark_seen(self, info: strawberry.Info, video_ids: list[int], seen: bool = True) -> int:
        return await _yt.mark_videos_seen(await _uid(info), video_ids, seen)

    @strawberry.field
    async def yt_switch_mode(
        self, info: strawberry.Info, channel_id: int, kind: str,
        words: list[str] | None = None, rank: str | None = None,
    ) -> bool:
        from returns.result import Success

        return isinstance(
            await _yt.switch_mode(await _uid(info), channel_id, kind, words, rank), Success
        )

    @strawberry.field
    async def yt_set_active(self, info: strawberry.Info, channel_id: int, active: bool) -> bool:
        from returns.result import Success

        return isinstance(await _yt.set_channel_active(await _uid(info), channel_id, active), Success)

    @strawberry.field
    async def yt_delete_channel(self, info: strawberry.Info, channel_id: int) -> bool:
        from returns.result import Success

        return isinstance(await _yt.delete_channel(await _uid(info), channel_id), Success)


# ---------------- Ani child ----------------
@strawberry.type
class AniEvent:
    id: int
    entry_id: int
    season_no: int | None
    kind: str
    tier: str
    seen: bool
    created_at: str
    payload: str


@strawberry.type
class AniSeason:
    season_no: int
    status: str | None
    episodes_total: int | None
    episodes_aired: int | None
    state: str
    watched: bool


@strawberry.type
class AniEntry:
    id: int
    title: str | None
    label: str
    list: str
    active: bool
    notify_release: bool
    canon_only: bool
    cursor: str
    total_seasons: int
    seasons: list[AniSeason]


@strawberry.type
class AniQuery:
    @strawberry.field
    async def ani_events(self, info: strawberry.Info, include_seen: bool = False) -> list[AniEvent]:
        import json

        events = await _ani.events_feed(await _uid(info), include_seen)
        return [
            AniEvent(
                id=e["id"], entry_id=e["entry_id"], season_no=e["season_no"], kind=e["kind"], tier=e["tier"],
                seen=e["seen"], created_at=e["created_at"], payload=json.dumps(e["payload"]),
            )
            for e in events
        ]

    @strawberry.field
    async def ani_management(self, info: strawberry.Info) -> list[AniEntry]:
        import json as _json

        view = await _ani.management_view(await _uid(info))
        return [
            AniEntry(
                id=e["id"], title=e["title"], label=e["label"], list=e["list"],
                active=e["active"], notify_release=e["notify_release"],
                canon_only=e["canon_only"], cursor=_json.dumps(e["cursor"]),
                total_seasons=e["total_seasons"],
                seasons=[AniSeason(**s) for s in e["seasons"]],
            )
            for e in view
        ]


@strawberry.type
class AniMutation:
    @strawberry.field
    async def ani_track(self, info: strawberry.Info, title: str, list_kind: str = "watching") -> bool:
        from returns.result import Failure, Success

        from Orchestrator.Ani.Fetch.ani_track import ani_fetch

        fetch = await ani_fetch(title)
        if isinstance(fetch, Failure):
            return False
        payload = fetch.unwrap()
        first = payload[0][1]
        result = await _ani.add_entry(
            await _uid(info), int(first["id"]), title, first.get("thumbnail"), payload, list_kind
        )
        return isinstance(result, Success)

    @strawberry.field
    async def ani_set_watched(self, info: strawberry.Info, entry_id: int, season_no: int, watched: bool) -> bool:
        from returns.result import Success

        return isinstance(
            await _ani.set_season_watched(await _uid(info), entry_id, season_no, watched), Success
        )

    @strawberry.field
    async def ani_set_cursor(
        self, info: strawberry.Info, entry_id: int, season: int,
        episode: int | None = None, position_seconds: int | None = None,
    ) -> bool:
        from returns.result import Success

        return isinstance(
            await _ani.set_cursor(await _uid(info), entry_id, season, episode, position_seconds),
            Success,
        )

    @strawberry.field
    async def ani_mark_range(self, info: strawberry.Info, entry_id: int, from_season: int, to_season: int) -> bool:
        from returns.result import Success

        return isinstance(
            await _ani.mark_range(await _uid(info), entry_id, from_season, to_season), Success
        )

    @strawberry.field
    async def ani_events_seen(self, info: strawberry.Info, event_ids: list[int], seen: bool = True) -> int:
        return await _ani.mark_events_seen(await _uid(info), event_ids, seen)

    @strawberry.field
    async def ani_delete_entry(self, info: strawberry.Info, entry_id: int) -> bool:
        from returns.result import Success

        return isinstance(await _ani.delete_entry(await _uid(info), entry_id), Success)


yt_schema = strawberry.Schema(query=YtQuery, mutation=YtMutation)
ani_schema = strawberry.Schema(query=AniQuery, mutation=AniMutation)
