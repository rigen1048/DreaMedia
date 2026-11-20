"""Unified GraphQL API — the frontend's ONLY data contract.

Every read and write the UI performs goes through this schema and its
supergraph (/graphql). The REST routers that remain mounted are the
frontend's *inbound* notification lane and internal/admin tooling; the UI
does not call them.

Design notes:
- One schema, two feature namespaces (yt / ani) plus auth + messages.
- YouTube notification types map to the subscription mode
  (tracking → Track, wordscan → WordScan, playlist → Playlist,
  random → Random).
- Notification scoping is exposed on the category tree and channel rows so
  the UI can mute a domain, a subdomain, or one channel.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Optional

import strawberry
from returns.result import Failure, Success
from strawberry.types import Info

from Auth import auth
from Database.ani_store import AniStore
from Database.card_store import CardStore
from Database.pg_store import PgStore

_yt = PgStore()
_ani = AniStore()


async def _enrich_card_items(user_id: int, pending: list[tuple[int, str]]) -> None:
    """Background metadata fill for manual playlist rows (best effort)."""
    from Orchestrator.Yt.Fetch.convert import resolve_video
    from Utility.logs import log

    store = CardStore()
    for item_id, url in pending:
        try:
            result = await asyncio.to_thread(resolve_video, url)
            if isinstance(result, Failure):
                continue
            video = result.unwrap()
            if video.title and not video.title.startswith("YouTube video "):
                await store.update_item_meta(user_id, item_id, video.title, video.thumbnail)
        except Exception:  # pragma: no cover - background best effort
            log.exception("card item enrichment failed for %s", url)


async def _uid(info: Info) -> int:
    request = info.context["request"]
    token = request.cookies.get("dreamedia")
    if not token:
        raise ValueError("Not authenticated")
    user_id = await auth.resolve_session(token)
    if user_id is None:
        raise ValueError("Session expired")
    return user_id


async def _optional_uid(info: Info) -> Optional[int]:
    request = info.context["request"]
    token = request.cookies.get("dreamedia")
    if not token:
        return None
    return await auth.resolve_session(token)


def _unwrap(result, fallback: str = "Request failed"):
    if isinstance(result, Failure):
        raise ValueError(result.failure() or fallback)
    return result.unwrap()


# ============================ Shared types ============================
@strawberry.type
class Viewer:
    id: int
    username: str
    role: str


@strawberry.type
class BackendMessage:
    id: int
    media: str
    kind: str
    title: str
    message: str
    level: str
    url: Optional[str]
    created_at: str
    seen: bool
    pushed: bool
    payload: str


# ============================ YouTube ============================
@strawberry.type
class YtVideo:
    id: int
    channel_id: int
    title: Optional[str]
    url: Optional[str]
    thumbnail: Optional[str]
    published_at: Optional[int]
    seen: bool
    channel: Optional[str]
    channel_logo: Optional[str]
    mode: str
    notify_enabled: bool
    label: str
    domain: str
    subdomain: str


@strawberry.type
class YtChannel:
    id: int
    name: Optional[str]
    url: Optional[str]
    logo: Optional[str]
    label: str
    label_reason: Optional[str]
    rss_id: Optional[str]
    kind: Optional[str]
    active: Optional[bool]
    rank: Optional[str]
    words: List[str]
    domain: str
    subdomain: str
    domain_id: Optional[int]
    subdomain_id: Optional[int]
    notify: bool
    notify_enabled: bool


@strawberry.type
class YtSubdomain:
    id: int
    name: str
    active: bool
    notify: bool
    channel_count: int
    blocked_count: int


@strawberry.type
class YtDomain:
    id: int
    name: str
    active: bool
    notify: bool
    channel_count: int
    subdomains: List[YtSubdomain]


@strawberry.type
class YtCardItem:
    id: int
    video_id: str
    url: Optional[str]
    title: Optional[str]
    thumbnail: Optional[str]
    done: bool
    added_at: str


@strawberry.type
class YtCard:
    id: int
    name: Optional[str]
    created_at: str
    total: int
    done: int
    items: List[YtCardItem]


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
    subdomains: List[YtSidebarSubdomain]


@strawberry.type
class YtTrashItem:
    id: int
    title: Optional[str]
    url: Optional[str]
    thumbnail: Optional[str]
    channel: Optional[str]
    published_at: Optional[int]
    trashed_at: int


@strawberry.type
class YtQuery:
    @strawberry.field
    async def yt_feed(self, info: Info, limit: int = 200) -> List[YtVideo]:
        videos = await _yt.feed(await _uid(info), limit)
        return [YtVideo(**v) for v in videos]

    @strawberry.field
    async def yt_channels(
        self, info: Info, include_blocked: bool = False
    ) -> List[YtChannel]:
        channels = await _yt.channels_view(await _uid(info), include_blocked)
        return [YtChannel(**c) for c in channels]

    @strawberry.field
    async def yt_domains(self, info: Info) -> List[YtDomain]:
        tree = await _yt.domains_tree(await _uid(info))
        return [
            YtDomain(
                id=d["id"], name=d["name"], active=d["active"], notify=d["notify"],
                channel_count=d.get("channel_count", 0),
                subdomains=[
                    YtSubdomain(
                        id=s["id"], name=s["name"], active=s["active"], notify=s["notify"],
                        channel_count=s.get("channel_count", 0),
                        blocked_count=s.get("blocked_count", 0),
                    )
                    for s in d["subdomains"]
                ],
            )
            for d in tree["domains"]
        ]

    @strawberry.field
    async def yt_unassigned_count(self, info: Info) -> int:
        tree = await _yt.domains_tree(await _uid(info))
        return int(tree.get("unassigned_channels") or 0)

    @strawberry.field
    async def yt_cards(self, info: Info) -> List[YtCard]:
        cards = await CardStore().list_cards(await _uid(info))
        return [
            YtCard(
                id=c["id"], name=c["name"], created_at=c["created_at"],
                total=c["total"], done=c["done"],
                items=[
                    YtCardItem(
                        id=i["id"], video_id=i["video_id"], url=i["url"], title=i["title"],
                        thumbnail=i["thumbnail"], done=i["done"], added_at=i["added_at"],
                    )
                    for i in c["items"]
                ],
            )
            for c in cards
        ]

    @strawberry.field
    async def yt_trash(self, info: Info) -> List[YtTrashItem]:
        rows = await _yt.trash_feed(await _uid(info))
        return [
            YtTrashItem(
                id=r["id"], title=r["title"], url=r["url"], thumbnail=r["thumbnail"],
                channel=r["channel"], published_at=r["published_at"], trashed_at=r["trashed_at"],
            )
            for r in rows
        ]

    @strawberry.field
    async def yt_sidebar(self, info: Info) -> List[YtSidebarDomain]:
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
        self, info: Info, kind: str, link: str, words: Optional[List[str]] = None,
        rank: Optional[str] = None, domain: Optional[str] = None,
        subdomain: Optional[str] = None,
    ) -> int:
        """Link-only subscribe. Server resolves the channel/playlist."""
        from Orchestrator.Yt.Fetch.convert import parse_playlist_id, resolve_channel

        user_id = await _uid(info)
        if kind == "playlist":
            playlist_id = parse_playlist_id(link)
            if not playlist_id:
                raise ValueError("Could not extract a playlist id from that link")
            info_res = await asyncio.to_thread(resolve_channel, link.split("?")[0])
            if isinstance(info_res, Failure):
                name, url, logo = "Playlist", link, None
            else:
                resolved = info_res.unwrap()
                name, url, logo = resolved.name, resolved.url, resolved.logo
            channel_id = _unwrap(
                await _yt.add_playlist(user_id, playlist_id, name, url, logo=logo)
            )
        else:
            info_res = await asyncio.to_thread(resolve_channel, link)
            if isinstance(info_res, Failure):
                raise ValueError(info_res.failure())
            resolved = info_res.unwrap()
            if kind in ("tracking", "wordscan"):
                channel_id = _unwrap(
                    await _yt.add_tracking(
                        user_id, resolved.rss_id, resolved.name, resolved.url,
                        kind=kind, words=words, logo=resolved.logo,
                    )
                )
            elif kind == "random":
                channel_id = _unwrap(
                    await _yt.add_random(
                        user_id, resolved.name, resolved.url, rank or "week",
                        logo=resolved.logo,
                    )
                )
            else:
                raise ValueError(f"Unknown notification type: {kind}")
        if domain and subdomain:
            await _yt.assign_category(user_id, channel_id, domain, subdomain)
        return channel_id

    @strawberry.field
    async def yt_trash_videos(self, info: Info, video_ids: List[int]) -> int:
        """Opening a notification trashes it (D57); 24h later it's purged."""
        return await _yt.trash_videos(await _uid(info), video_ids)

    @strawberry.field
    async def yt_restore_videos(self, info: Info, video_ids: List[int]) -> int:
        return await _yt.restore_videos(await _uid(info), video_ids)

    @strawberry.field
    async def yt_set_blocked_category(
        self, info: Info, channel_id: int,
        domain: Optional[str] = None, subdomain: Optional[str] = None,
    ) -> bool:
        _unwrap(await _yt.set_blocked_category(
            await _uid(info), channel_id, domain, subdomain
        ))
        return True

    @strawberry.field
    async def yt_set_label(
        self, info: Info, channel_id: int, label: str, reason: Optional[str] = None
    ) -> bool:
        _unwrap(await _yt.set_label(await _uid(info), channel_id, label, reason))
        return True

    @strawberry.field
    async def yt_fetch_now(self, info: Info) -> int:
        """Queue every active subscription of this user and wake the manager.

        Returns how many subscriptions are due now — the UI shows it in the
        toast, the polling itself stays in the one background manager.
        """
        from Orchestrator.Yt import manager

        queued = await _yt.request_fetch_now(await _uid(info))
        manager.wake()
        return queued

    @strawberry.field
    async def yt_mark_seen(
        self, info: Info, video_ids: List[int], seen: bool = True
    ) -> int:
        return await _yt.mark_videos_seen(await _uid(info), video_ids, seen)

    @strawberry.field
    async def yt_switch_mode(
        self, info: Info, channel_id: int, kind: str,
        words: Optional[List[str]] = None, rank: Optional[str] = None,
    ) -> bool:
        _unwrap(await _yt.switch_mode(await _uid(info), channel_id, kind, words, rank))
        return True

    @strawberry.field
    async def yt_set_active(self, info: Info, channel_id: int, active: bool) -> bool:
        _unwrap(await _yt.set_channel_active(await _uid(info), channel_id, active))
        return True

    @strawberry.field
    async def yt_set_notify(self, info: Info, channel_id: int, notify: bool) -> bool:
        _unwrap(await _yt.set_channel_notify(await _uid(info), channel_id, notify))
        return True

    @strawberry.field
    async def yt_delete_channel(self, info: Info, channel_id: int) -> bool:
        _unwrap(await _yt.delete_channel(await _uid(info), channel_id))
        return True

    @strawberry.field
    async def yt_create_domain(self, info: Info, name: str) -> int:
        return int(_unwrap(await _yt.create_domain(await _uid(info), name))["id"])

    @strawberry.field
    async def yt_rename_domain(self, info: Info, domain_id: int, name: str) -> bool:
        _unwrap(await _yt.rename_domain(await _uid(info), domain_id, name))
        return True

    @strawberry.field
    async def yt_delete_domain(self, info: Info, domain_id: int) -> bool:
        _unwrap(await _yt.delete_domain(await _uid(info), domain_id))
        return True

    @strawberry.field
    async def yt_set_domain_notify(self, info: Info, domain_id: int, notify: bool) -> bool:
        _unwrap(await _yt.set_domain_notify(await _uid(info), domain_id, notify))
        return True

    @strawberry.field
    async def yt_create_subdomain(self, info: Info, domain_id: int, name: str) -> int:
        return int(
            _unwrap(await _yt.create_subdomain(await _uid(info), domain_id, name))["id"]
        )

    @strawberry.field
    async def yt_rename_subdomain(self, info: Info, subdomain_id: int, name: str) -> bool:
        _unwrap(await _yt.rename_subdomain(await _uid(info), subdomain_id, name))
        return True

    @strawberry.field
    async def yt_delete_subdomain(self, info: Info, subdomain_id: int) -> bool:
        _unwrap(await _yt.delete_subdomain(await _uid(info), subdomain_id))
        return True

    @strawberry.field
    async def yt_set_subdomain_notify(
        self, info: Info, subdomain_id: int, notify: bool
    ) -> bool:
        _unwrap(await _yt.set_subdomain_notify(await _uid(info), subdomain_id, notify))
        return True

    @strawberry.field
    async def yt_assign_channel(
        self, info: Info, channel_id: int, subdomain_id: Optional[int] = None,
        domain: Optional[str] = None, subdomain: Optional[str] = None,
    ) -> bool:
        """Attach a channel to an existing subdomain id, or get-or-create one
        by domain/subdomain names (the "attach to channel" workflow)."""
        user_id = await _uid(info)
        if subdomain_id is None and domain and subdomain:
            _unwrap(await _yt.assign_category(user_id, channel_id, domain, subdomain))
            return True
        _unwrap(await _yt.assign_channel(user_id, channel_id, subdomain_id))
        return True

    @strawberry.field
    async def yt_create_card(self, info: Info, name: str) -> int:
        return int(_unwrap(await CardStore().create_card(await _uid(info), name)))

    @strawberry.field
    async def yt_rename_card(self, info: Info, card_id: int, name: str) -> bool:
        _unwrap(await CardStore().rename_card(await _uid(info), card_id, name))
        return True

    @strawberry.field
    async def yt_add_card_items(
        self, info: Info, card_id: int, links: List[str]
    ) -> int:
        """Bulk add by pasted video links; each link is resolved server-side."""
        from Orchestrator.Yt.Fetch.convert import resolve_video

        from Orchestrator.Yt.Fetch.convert import parse_video_id

        user_id = await _uid(info)
        pending: list[tuple[int, str]] = []
        invalid: list[str] = []
        for link in links:
            link = link.strip()
            if not link:
                continue
            video_id = parse_video_id(link)
            if not video_id:
                invalid.append(link)
                continue
            url = f"https://www.youtube.com/watch?v={video_id}"
            item_id = _unwrap(
                await CardStore().add_item(
                    user_id, card_id, video_id, url,
                    f"YouTube video {video_id}",
                    f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
                )
            )
            pending.append((item_id, url))
        if invalid and not pending:
            raise ValueError(f"Not a YouTube video link: {invalid[0]}")
        if pending:
            # Never block the mutation on YouTube: insert now, enrich in the
            # background (yt-dlp -> oEmbed -> keep the placeholder).
            asyncio.create_task(_enrich_card_items(user_id, pending))
        return len(pending)

    @strawberry.field
    async def yt_set_card_item_done(
        self, info: Info, item_id: int, done: bool
    ) -> bool:
        _unwrap(await CardStore().set_item_done(await _uid(info), item_id, done))
        return True

    @strawberry.field
    async def yt_delete_card(self, info: Info, card_id: int) -> bool:
        _unwrap(await CardStore().delete_card(await _uid(info), card_id))
        return True

    @strawberry.field
    async def yt_delete_card_item(self, info: Info, item_id: int) -> bool:
        _unwrap(await CardStore().delete_item(await _uid(info), item_id))
        return True


# ============================ Anime ============================
_EVENT_GROUP = {
    "next_episode_date": ("release", "today", "Episode airing"),
    "episode_released": ("release", "today", "Episode released"),
    "release_confirmed": ("release", "today", "Release confirmed"),
    "next_sequel_date": ("release", "sequel", "Sequel announced"),
    "next_sequel": ("release", "sequel", "Next sequel"),
    "new_anime_date": ("release", "new", "New anime"),
    "episode_postponed": ("change", "today", "Episode postponed"),
    "release_changed": ("change", "today", "Release changed"),
}


@strawberry.type
class AniEvent:
    id: int
    entry_id: int
    title: Optional[str]
    cover: Optional[str]
    anime_type: Optional[str]
    season_no: Optional[int]
    kind: str
    group: str
    bucket: str
    label: str
    tier: str
    seen: bool
    created_at: str
    payload: str
    domain: str
    subdomain: str
    notify_enabled: bool


@strawberry.type
class AniSeason:
    season_no: int
    title: Optional[str]
    poster: Optional[str]
    status: Optional[str]
    episodes_total: Optional[int]
    episodes_aired: Optional[int]
    state: str
    watched: bool
    start_date: Optional[str]
    release_date: Optional[str]
    next_airing_at: Optional[int]
    next_airing_ep: Optional[int]


@strawberry.type
class AniAdvance:
    """What "finish this season" decided, straight from the cached chain."""

    action: str                     # watching | awaiting | completed
    season: int
    episode: Optional[int]
    title: Optional[str]
    release_date: Optional[str]
    episodes_total: Optional[int]


@strawberry.type
class AniEntry:
    id: int
    title: Optional[str]
    cover: Optional[str]
    label: str
    label_reason: Optional[str]
    list: str
    watch_state: Optional[str]
    active: bool
    notify_release: bool
    notify_enabled: bool
    canon_only: bool
    anime_type: Optional[str]
    airing_time: Optional[str]
    domain_id: Optional[int]
    subdomain_id: Optional[int]
    domain: str
    subdomain: str
    cursor_season: Optional[int]
    cursor_episode: Optional[int]
    position_seconds: Optional[int]
    total_seasons: int
    episode_count: int
    aired_count: int
    watched_seasons: int
    release_date: Optional[str]
    next_airing_at: Optional[int]
    next_airing_ep: Optional[int]
    seasons: List[AniSeason]


@strawberry.type
class AniDomain:
    id: int
    name: str
    active: bool
    notify: bool
    channel_count: int
    subdomains: List[YtSubdomain]


@strawberry.type
class AniTrashItem:
    id: int
    entry_id: int
    season_no: Optional[int]
    kind: str
    title: Optional[str]
    cover: Optional[str]
    payload: str
    created_at: str
    trashed_at: int


@strawberry.type
class AniTodo:
    id: int
    entry_id: Optional[int]
    title: Optional[str]
    season_no: int
    episode: int
    position_seconds: int
    done: bool
    created_at: int


@strawberry.type
class AniQuery:
    @strawberry.field
    async def ani_events(
        self, info: Info, include_seen: bool = True
    ) -> List[AniEvent]:
        events = await _ani.events_feed(await _uid(info), include_seen)
        result = []
        for e in events:
            group, bucket, label = _EVENT_GROUP.get(
                e["kind"], ("release", "today", e["kind"].replace("_", " ").title())
            )
            if e["kind"] == "release_changed" and (e.get("season_no") or 1) > 1:
                bucket = "sequel"
            result.append(
                AniEvent(
                    id=e["id"], entry_id=e["entry_id"], title=e.get("title"),
                    cover=e.get("cover"), anime_type=e.get("anime_type"),
                    season_no=e["season_no"], kind=e["kind"], group=group,
                    bucket=bucket, label=label, tier=e["tier"], seen=e["seen"],
                    created_at=e["created_at"],
                    payload=json.dumps(e["payload"], default=str),
                    domain=e.get("domain", "uncategorized"),
                    subdomain=e.get("subdomain", "uncategorized"),
                    notify_enabled=bool(e.get("notify_enabled")),
                )
            )
        return result

    @strawberry.field
    async def ani_entries(
        self, info: Info, include_blocked: bool = False
    ) -> List[AniEntry]:
        view = await _ani.management_view(await _uid(info), include_blocked)
        return [
            AniEntry(
                id=e["id"], title=e["title"], cover=e.get("cover"), label=e["label"],
                label_reason=e.get("label_reason"), list=e["list"],
                watch_state=e.get("watch_state"), active=e["active"],
                notify_release=e["notify_release"], notify_enabled=e["notify_enabled"],
                canon_only=e["canon_only"], anime_type=e.get("anime_type"),
                airing_time=e.get("airing_time"), domain_id=e.get("domain_id"),
                subdomain_id=e.get("subdomain_id"), domain=e["domain"],
                subdomain=e["subdomain"], cursor_season=e["cursor"]["season"],
                cursor_episode=e["cursor"]["episode"],
                position_seconds=e["cursor"]["position_seconds"],
                total_seasons=e["total_seasons"], episode_count=e["episode_count"],
                aired_count=e["aired_count"], watched_seasons=e["watched_seasons"],
                release_date=e.get("release_date"),
                next_airing_at=e.get("next_airing_at"),
                next_airing_ep=e.get("next_airing_ep"),
                seasons=[AniSeason(**s) for s in e["seasons"]],
            )
            for e in view
        ]

    @strawberry.field
    async def ani_trash(self, info: Info) -> List[AniTrashItem]:
        rows = await _ani.trash_feed(await _uid(info))
        return [
            AniTrashItem(
                id=r["id"], entry_id=r["entry_id"], season_no=r["season_no"],
                kind=r["kind"], title=r["title"], cover=r["cover"],
                payload=r["payload"], created_at=r["created_at"], trashed_at=r["trashed_at"],
            )
            for r in rows
        ]

    @strawberry.field
    async def ani_todo(self, info: Info) -> List[AniTodo]:
        """Halfway-watch bookmarks (cleanup #2) — explicitly separate from
        the YT custom playlists."""
        return [AniTodo(**t) for t in await _ani.todo_list(await _uid(info))]

    @strawberry.field
    async def ani_domains(self, info: Info) -> List[AniDomain]:
        tree = await _ani.domains_tree(await _uid(info))
        return [
            AniDomain(
                id=d["id"], name=d["name"], active=d["active"], notify=d["notify"],
                channel_count=d.get("channel_count", 0),
                subdomains=[
                    YtSubdomain(
                        id=s["id"], name=s["name"], active=s["active"], notify=s["notify"],
                        channel_count=s.get("channel_count", 0),
                        blocked_count=s.get("blocked_count", 0),
                    )
                    for s in d["subdomains"]
                ],
            )
            for d in tree["domains"]
        ]


@strawberry.type
class AniMutation:
    @strawberry.field
    async def ani_track(
        self, info: Info, title: str, list_kind: str = "watching",
        domain: Optional[str] = None, subdomain: Optional[str] = None,
    ) -> int:
        from Orchestrator.Ani.Fetch.ani_track import ani_fetch

        user_id = await _uid(info)
        fetch = await ani_fetch(title)
        if isinstance(fetch, Failure):
            raise ValueError(fetch.failure())
        payload = fetch.unwrap()
        first = payload[0][1]
        subdomain_id = None
        if domain and subdomain:
            subdomain_id = await _ani.ensure_category(user_id, domain, subdomain)
        entry_id = int(
            _unwrap(
                await _ani.add_entry(
                    user_id, int(first["id"]), title, first.get("thumbnail"), payload,
                    list_kind, anime_type=first.get("format"),
                    subdomain_id=subdomain_id,
                )
            )
        )
        if list_kind == "up_to_date":
            _unwrap(await _ani.update_entry(user_id, entry_id, notify_release=True))
        return entry_id

    @strawberry.field
    async def ani_update_entry(
        self, info: Info, entry_id: int, list_kind: Optional[str] = None,
        watch_state: Optional[str] = None, label: Optional[str] = None,
        label_reason: Optional[str] = None, notify_release: Optional[bool] = None,
        active: Optional[bool] = None, canon_only: Optional[bool] = None,
        anime_type: Optional[str] = None, subdomain_id: Optional[int] = None,
        clear_category: bool = False,
    ) -> bool:
        _unwrap(
            await _ani.update_entry(
                await _uid(info), entry_id, label=label, label_reason=label_reason,
                list_kind=list_kind, notify_release=notify_release, active=active,
                canon_only=canon_only, watch_state=watch_state, anime_type=anime_type,
                subdomain_id=subdomain_id, clear_category=clear_category,
            )
        )
        return True

    @strawberry.field
    async def ani_set_watched(
        self, info: Info, entry_id: int, season_no: int, watched: bool
    ) -> bool:
        _unwrap(
            await _ani.set_season_watched(await _uid(info), entry_id, season_no, watched)
        )
        return True

    @strawberry.field
    async def ani_set_cursor(
        self, info: Info, entry_id: int, season: int,
        episode: Optional[int] = None, position_seconds: Optional[int] = None,
    ) -> bool:
        _unwrap(
            await _ani.set_cursor(await _uid(info), entry_id, season, episode, position_seconds)
        )
        return True

    @strawberry.field
    async def ani_set_progress(
        self, info: Info, entry_id: int, season: int, episode: int,
        position_seconds: Optional[int] = None,
    ) -> bool:
        """Correct the watch position, backwards included (unlike the +1 cursor)."""
        _unwrap(await _ani.set_progress(
            await _uid(info), entry_id, season, episode, position_seconds
        ))
        return True

    @strawberry.field
    async def ani_mark_range(
        self, info: Info, entry_id: int, from_season: int, to_season: int
    ) -> bool:
        _unwrap(
            await _ani.mark_range(await _uid(info), entry_id, from_season, to_season)
        )
        return True

    @strawberry.field
    async def ani_finish(self, info: Info, entry_id: int) -> bool:
        _unwrap(await _ani.mark_all_watched(await _uid(info), entry_id))
        return True

    @strawberry.field
    async def ani_advance_season(
        self, info: Info, entry_id: int, from_season: Optional[int] = None
    ) -> AniAdvance:
        """Finish a season and let the backend decide where the entry lands:
        the next season is already out → watching at its first episode, it has
        a future date → Next sequel with that date, no next season → completed.
        """
        data = _unwrap(
            await _ani.advance_season(await _uid(info), entry_id, from_season)
        )
        return AniAdvance(
            action=data["action"],
            season=data["season"],
            episode=data.get("episode"),
            title=data.get("title"),
            release_date=data.get("release_date"),
            episodes_total=data.get("episodes_total"),
        )

    @strawberry.field
    async def ani_events_seen(
        self, info: Info, event_ids: List[int], seen: bool = True
    ) -> int:
        return await _ani.mark_events_seen(await _uid(info), event_ids, seen)

    @strawberry.field
    async def ani_trash_events(self, info: Info, event_ids: List[int]) -> int:
        """Opening an event trashes it (D57); 24h later it's purged."""
        return await _ani.trash_events(await _uid(info), event_ids)

    @strawberry.field
    async def ani_restore_events(self, info: Info, event_ids: List[int]) -> int:
        return await _ani.restore_events(await _uid(info), event_ids)

    @strawberry.field
    async def ani_todo_add(
        self, info: Info, season_no: int, episode: int,
        position_seconds: int = 0, entry_id: Optional[int] = None,
        title: Optional[str] = None,
    ) -> int:
        return _unwrap(await _ani.todo_add(
            await _uid(info), season_no=season_no, episode=episode,
            position_seconds=position_seconds, entry_id=entry_id, title=title,
        ))

    @strawberry.field
    async def ani_todo_update(
        self, info: Info, todo_id: int, done: Optional[bool] = None,
        episode: Optional[int] = None, position_seconds: Optional[int] = None,
    ) -> bool:
        _unwrap(await _ani.todo_update(
            await _uid(info), todo_id, done=done, episode=episode,
            position_seconds=position_seconds,
        ))
        return True

    @strawberry.field
    async def ani_todo_delete(self, info: Info, todo_id: int) -> bool:
        _unwrap(await _ani.todo_delete(await _uid(info), todo_id))
        return True

    @strawberry.field
    async def ani_set_blocked_category(
        self, info: Info, entry_id: int,
        domain: Optional[str] = None, subdomain: Optional[str] = None,
    ) -> bool:
        """Blocked/reserved entries carry their OWN domain/subdomain (cleanup #4)."""
        _unwrap(await _ani.set_blocked_category(
            await _uid(info), entry_id, domain, subdomain
        ))
        return True

    @strawberry.field
    async def ani_delete_entry(self, info: Info, entry_id: int) -> bool:
        _unwrap(await _ani.delete_entry(await _uid(info), entry_id))
        return True

    @strawberry.field
    async def ani_create_domain(self, info: Info, name: str) -> int:
        return int(_unwrap(await _ani.create_domain(await _uid(info), name))["id"])

    @strawberry.field
    async def ani_rename_domain(self, info: Info, domain_id: int, name: str) -> bool:
        _unwrap(await _ani.rename_domain(await _uid(info), domain_id, name))
        return True

    @strawberry.field
    async def ani_delete_domain(self, info: Info, domain_id: int) -> bool:
        _unwrap(await _ani.delete_domain(await _uid(info), domain_id))
        return True

    @strawberry.field
    async def ani_set_domain_notify(
        self, info: Info, domain_id: int, notify: bool
    ) -> bool:
        _unwrap(await _ani.set_domain_notify(await _uid(info), domain_id, notify))
        return True

    @strawberry.field
    async def ani_create_subdomain(self, info: Info, domain_id: int, name: str) -> int:
        return int(
            _unwrap(await _ani.create_subdomain(await _uid(info), domain_id, name))["id"]
        )

    @strawberry.field
    async def ani_rename_subdomain(
        self, info: Info, subdomain_id: int, name: str
    ) -> bool:
        _unwrap(await _ani.rename_subdomain(await _uid(info), subdomain_id, name))
        return True

    @strawberry.field
    async def ani_delete_subdomain(self, info: Info, subdomain_id: int) -> bool:
        _unwrap(await _ani.delete_subdomain(await _uid(info), subdomain_id))
        return True

    @strawberry.field
    async def ani_set_subdomain_notify(
        self, info: Info, subdomain_id: int, notify: bool
    ) -> bool:
        _unwrap(await _ani.set_subdomain_notify(await _uid(info), subdomain_id, notify))
        return True

    @strawberry.field
    async def ani_assign_entry(
        self, info: Info, entry_id: int, subdomain_id: Optional[int] = None,
        domain: Optional[str] = None, subdomain: Optional[str] = None,
    ) -> bool:
        user_id = await _uid(info)
        if subdomain_id is None and domain and subdomain:
            new_id = await _ani.ensure_category(user_id, domain, subdomain)
            _unwrap(await _ani.assign_entry(user_id, entry_id, new_id))
            return True
        _unwrap(await _ani.assign_entry(user_id, entry_id, subdomain_id))
        return True


yt_schema = strawberry.Schema(query=YtQuery, mutation=YtMutation)
ani_schema = strawberry.Schema(query=AniQuery, mutation=AniMutation)
