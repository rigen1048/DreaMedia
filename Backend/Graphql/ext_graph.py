"""Extension GraphQL API (ext v2 phase 2): the single token-authed lane.

Mounted at /ext/graphql. Deliberately small and stable — the extension is
released software that can't ride internal refactors, exactly like the REST
/ext router it replaces. The extension uses graphql-transport-ws exclusively;
its token is sent once in connection_init's payload, which Strawberry exposes
as context["connection_params"].
"""
from __future__ import annotations

from typing import List, Optional

import strawberry
from returns.result import Failure
from strawberry.types import Info

from Database.ani_store import AniStore
from Database.card_store import CardStore
from Database.pg_store import PgStore
from Extension import anchor, live, store
from Extension.tokens import user_for_token

_ani = AniStore()
_cards = CardStore()
_yt = PgStore()
_domains = store.ExtDomainStore()


async def ext_context():
    # The ws token arrives in connection_init AFTER the context is created,
    # so Strawberry merges it into this dict as "connection_params".
    return {}


async def _ext_uid(info: Info) -> int:
    ctx = info.context
    user_id = ctx.get("ext_user_id")
    if user_id is not None:
        return user_id
    params = ctx.get("connection_params") or {}
    token = params.get("token", "")
    if not token:
        raise ValueError("extension GraphQL requires WebSocket authentication")
    user_id = await user_for_token(token)
    if user_id is None:
        raise ValueError("invalid extension token")
    # Validate connection_init once, then reuse that authenticated identity
    # for every resolver operation on this socket until it closes.
    ctx["ext_user_id"] = user_id
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

    @strawberry.field
    async def blocked_list(self, info: Info) -> List[BlockedChannel]:
        """Phase 4: blocked YouTube channels for the extension's local
        disclaimer cache. Refresh needs the vault (names/urls are
        ciphertext); the extension keeps its last copy when locked."""
        return [BlockedChannel(**r) for r in _unwrap(await store.list_blocked_yt(await _ext_uid(info)))]

    @strawberry.field
    async def cards(self, info: Info) -> List[ExtCard]:
        """Todo cards the popup can add the current page's video to."""
        rows = await _cards.list_cards(await _ext_uid(info))
        return [ExtCard(id=r["id"], name=r.get("name"), done=r["done"], total=r["total"]) for r in rows]

    @strawberry.field
    async def ani_entries(self, info: Info) -> List[AniEntryOption]:
        """Entries the popup can bind a tab to (id, title, seasons, cursor)."""
        view = await _ani.management_view(await _ext_uid(info))
        return [
            AniEntryOption(
                id=e.get("id"), title=e.get("title"),
                seasons=[sn.get("season_no") for sn in e.get("seasons", []) if isinstance(sn, dict)],
                cursor_season=(e.get("cursor") or {}).get("season"),
                cursor_episode=(e.get("cursor") or {}).get("episode"),
            )
            for e in view
        ]

    @strawberry.field
    async def domains(self, info: Info) -> List[ExtDomainInfo]:
        """Enabled allowlist for content-script registration (phase 1)."""
        rows = await _domains.list_domains(await _ext_uid(info), enabled_only=True)
        if any(r["domain"] is None for r in rows):
            raise ValueError("vault locked (D9)")
        return [ExtDomainInfo(**r) for r in rows]

    @strawberry.field
    async def yt_categories(self, info: Info) -> List[ExtCategoryOption]:
        """Full YouTube category tree used for valid extension suggestions."""
        tree = await _yt.domains_tree(await _ext_uid(info))
        return [
            ExtCategoryOption(
                id=domain["id"],
                name=domain.get("name") or "",
                subdomains=[
                    ExtSubdomainOption(id=subdomain["id"], name=subdomain.get("name") or "")
                    for subdomain in domain.get("subdomains", [])
                ],
            )
            for domain in tree.get("domains", [])
        ]


@strawberry.type
class AnchorMatch:
    entry_id: int
    season: Optional[int]       # parsed from the page; None = not stated there
    episode: Optional[int]      # parsed (absolute numbers resolved via the chain)
    cursor_season: Optional[int]    # fallbacks for the binding
    cursor_episode: Optional[int]
    blocked: bool               # phase 4: matched a blocked entry -> disclaimer
    reason: Optional[str]       # the user's block reason, if they wrote one


@strawberry.type
class BlockedChannel:
    name: str
    url: str
    reason: Optional[str]


@strawberry.type
class ExtCard:
    id: int
    name: Optional[str]
    done: int
    total: int


@strawberry.type
class ExtDomainInfo:
    id: int
    domain: Optional[str]
    media: str
    enabled: bool


@strawberry.type
class ExtSubdomainOption:
    id: int
    name: str


@strawberry.type
class ExtCategoryOption:
    id: int
    name: str
    subdomains: List[ExtSubdomainOption]


@strawberry.type
class AniEntryOption:
    id: int
    title: Optional[str]
    seasons: List[int]
    cursor_season: Optional[int]
    cursor_episode: Optional[int]


@strawberry.type
class SubscribeResult:
    ok: bool
    channel_id: int


@strawberry.type
class AddItemsResult:
    added: int
    requested: int
    errors: List[str]


@strawberry.type
class BatchImportResult:
    added: int
    skipped: int
    requested: int
    errors: List[str]


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
        self, info: Info, entry_id: int, season: int, episode: int,
        position_seconds: int, event_time_ms: Optional[str] = None,
    ) -> bool:
        """Live-session upsert — the heartbeat while watching."""
        _unwrap(await live.upsert_position(
            await _ext_uid(info), entry_id, season, episode, position_seconds, event_time_ms
        ))
        return True

    @strawberry.field
    async def live_end(
        self, info: Info, entry_id: int, season: int, episode: int,
        position_seconds: int, event_time_ms: Optional[str] = None,
    ) -> bool:
        """Pause/ended: merge the final position into the real cursor."""
        _unwrap(await live.end_session(
            await _ext_uid(info), entry_id, season, episode, position_seconds, event_time_ms
        ))
        return True

    @strawberry.field
    async def subscribe(
        self, info: Info, link: str, kind: str = "tracking",
        words: Optional[List[str]] = None, rank: Optional[str] = None,
        withhold: Optional[int] = None,
        domain: Optional[str] = None, subdomain: Optional[str] = None,
    ) -> SubscribeResult:
        """Subscribe-from-page (HydraTracker capability): the popup sends
        the current tab's URL; resolution happens server-side. Categories
        are optional as a pair because YouTube channels attach to subdomains."""
        import asyncio

        from Orchestrator.Yt.Fetch.convert import parse_playlist_id, resolve_channel

        user_id = await _ext_uid(info)
        if kind == "withhold" and (withhold is None or withhold < 1):
            raise ValueError("withhold threshold must be >= 1")
        category_domain = domain.strip() if domain and domain.strip() else None
        category_subdomain = subdomain.strip() if subdomain and subdomain.strip() else None
        if bool(category_domain) != bool(category_subdomain):
            raise ValueError("choose both a domain and subdomain, or leave both empty")
        if kind == "playlist":
            playlist_id = parse_playlist_id(link)
            if not playlist_id:
                raise ValueError("could not extract a playlist id from that link")
            info_r = await asyncio.to_thread(resolve_channel, link.split("?")[0])
            if isinstance(info_r, Failure):
                name, url, logo = "Playlist", link, None
            else:
                resolved = info_r.unwrap()
                name, url, logo = resolved.name, resolved.url, resolved.logo
            result = await _yt.add_extension_subscription(
                user_id, channel_name=name, channel_url=url, kind=kind,
                playlist_id=playlist_id, rank=rank, domain=category_domain,
                subdomain=category_subdomain, logo=logo,
            )
        elif kind in ("tracking", "wordscan", "withhold"):
            info_r = await asyncio.to_thread(resolve_channel, link)
            if isinstance(info_r, Failure):
                raise ValueError(info_r.failure())
            resolved = info_r.unwrap()
            result = await _yt.add_extension_subscription(
                user_id, rss_id=resolved.rss_id, channel_name=resolved.name,
                channel_url=resolved.url, kind=kind,
                words=words if kind == "wordscan" else None,
                withhold=withhold if kind == "withhold" else None,
                domain=category_domain, subdomain=category_subdomain, logo=resolved.logo,
            )
        elif kind == "random":
            info_r = await asyncio.to_thread(resolve_channel, link)
            if isinstance(info_r, Failure):
                raise ValueError(info_r.failure())
            resolved = info_r.unwrap()
            result = await _yt.add_extension_subscription(
                user_id, channel_name=resolved.name, channel_url=resolved.url,
                kind=kind, rank=rank or "week", domain=category_domain,
                subdomain=category_subdomain, logo=resolved.logo,
            )
        else:
            raise ValueError(f"unknown kind: {kind}")
        channel_id = _unwrap(result)["channel_id"]
        return SubscribeResult(ok=True, channel_id=channel_id)

    @strawberry.field
    async def import_youtube_channels(
        self, info: Info, links: List[str], kind: str = "tracking",
        words: Optional[List[str]] = None, rank: Optional[str] = None,
        withhold: Optional[int] = None, domain: Optional[str] = None,
        subdomain: Optional[str] = None,
    ) -> BatchImportResult:
        """Import a user-confirmed batch of YouTube channel links.

        Each source write is atomic and existing channels are left untouched.
        The extension sends small batches so progress and individual errors
        remain visible rather than holding one large database transaction.
        """
        import asyncio
        import re
        from urllib.parse import urlsplit

        from Orchestrator.Yt.Fetch.convert import resolve_channel

        if len(links) > 50:
            raise ValueError("batch size cannot exceed 50 channels")
        if kind not in ("tracking", "wordscan", "random", "withhold"):
            raise ValueError("batch import supports tracking, wordscan, random, or withhold")
        if kind == "withhold" and (withhold is None or withhold < 1):
            raise ValueError("withhold threshold must be >= 1")
        category_domain = domain.strip() if domain and domain.strip() else None
        category_subdomain = subdomain.strip() if subdomain and subdomain.strip() else None
        if bool(category_domain) != bool(category_subdomain):
            raise ValueError("choose both a domain and subdomain, or leave both empty")

        channel_path = re.compile(r"^/(?:@[^/]+|channel/UC[A-Za-z0-9_-]{22})(?:/|$)")
        unique_links: List[str] = []
        seen_links = set()
        errors: List[str] = []
        duplicate_links = 0
        for raw_link in links:
            link = raw_link.strip()
            try:
                parsed = urlsplit(link)
            except ValueError:
                errors.append(f"{raw_link}: invalid URL")
                continue
            host = (parsed.hostname or "").lower()
            if parsed.scheme not in ("http", "https") or not (
                host == "youtube.com" or host.endswith(".youtube.com")
            ) or not channel_path.match(parsed.path):
                errors.append(f"{raw_link}: not a supported YouTube channel link")
                continue
            key = f"{host}{parsed.path.rstrip('/')}".casefold()
            if key in seen_links:
                duplicate_links += 1
                continue
            seen_links.add(key)
            unique_links.append(link)

        user_id = await _ext_uid(info)
        semaphore = asyncio.Semaphore(4)

        async def resolve_one(link: str):
            async with semaphore:
                try:
                    resolved_result = await asyncio.to_thread(resolve_channel, link)
                except Exception:
                    return ("error", f"{link}: channel lookup failed")
                if isinstance(resolved_result, Failure):
                    return ("error", f"{link}: {resolved_result.failure()}")
                return ("resolved", link, resolved_result.unwrap())

        resolved_results = await asyncio.gather(*(resolve_one(link) for link in unique_links))
        added = 0
        skipped = duplicate_links
        seen_channels = set()
        for result in resolved_results:
            if result[0] == "error":
                errors.append(result[1])
                continue
            _status, link, resolved = result
            canonical_url = resolved.url.rstrip("/").casefold()
            if canonical_url in seen_channels:
                skipped += 1
                continue
            seen_channels.add(canonical_url)
            try:
                stored = await _yt.add_extension_subscription(
                    user_id, rss_id=resolved.rss_id,
                    channel_name=resolved.name, channel_url=resolved.url,
                    kind=kind, words=words if kind == "wordscan" else None,
                    rank=rank or "week", withhold=withhold if kind == "withhold" else None,
                    domain=category_domain, subdomain=category_subdomain,
                    logo=resolved.logo, skip_existing=True,
                )
            except Exception:
                seen_channels.discard(canonical_url)
                errors.append(f"{link}: database write failed")
                continue
            if isinstance(stored, Failure):
                seen_channels.discard(canonical_url)
                errors.append(f"{link}: {stored.failure()}")
                continue
            if stored.unwrap()["created"]:
                added += 1
            else:
                skipped += 1
        return BatchImportResult(
            added=added, skipped=skipped, requested=len(links), errors=errors
        )

    @strawberry.field
    async def create_card(self, info: Info, name: str) -> ExtCard:
        result = await _cards.create_card(await _ext_uid(info), name)
        card_id = _unwrap(result)
        return ExtCard(id=card_id, name=name, done=0, total=0)

    @strawberry.field
    async def add_card_items(self, info: Info, card_id: int, links: List[str]) -> AddItemsResult:
        """Paste video links — resolved (title/thumb) once at add-time (D47)."""
        import asyncio

        from Orchestrator.Yt.Fetch.convert import resolve_video

        user_id = await _ext_uid(info)
        added = 0
        errors: List[str] = []
        for link in links:
            info_r = await asyncio.to_thread(resolve_video, link)
            if isinstance(info_r, Failure):
                errors.append(f"{link}: {info_r.failure()}")
                continue
            video = info_r.unwrap()
            result = await _cards.add_item_detailed(
                user_id, card_id, video.video_id, video.url, video.title, video.thumbnail
            )
            if isinstance(result, Failure):
                errors.append(f"{link}: {result.failure()}")
            elif result.unwrap()["added"]:
                added += 1
        return AddItemsResult(added=added, requested=len(links), errors=errors)

    @strawberry.field
    async def add_domain(self, info: Info, domain: str, media: str = "ani") -> ExtDomainInfo:
        """The popup's 'Enable DreaMedia on this site' button (phase 1)."""
        result = await _domains.add_domain(await _ext_uid(info), domain, media)
        return ExtDomainInfo(**_unwrap(result))


ext_schema = strawberry.Schema(query=ExtQuery, mutation=ExtMutation)
