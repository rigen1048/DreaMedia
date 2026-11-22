"""Per-anime watch sites (ani_watch_sites).

The current page URL is learned after a successful title match. Episode links
are retargeted only through an identifiable URL locator (episode query key,
explicit ep token, or a trailing numeric segment on a watch-style route), never
by replacing an arbitrary matching number elsewhere in the URL.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, unquote_plus, urlsplit, urlunsplit

from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt, encrypt, index_hash
from Database.db import get_pool
from Extension.store import _normalize

_EPISODE_QUERY_KEYS = ("ep_num", "episode_num", "episode_no", "episode", "ep")
_SEASON_QUERY_KEYS = ("season_num", "season_no", "season", "s")
_WATCH_ROUTE_ROOTS = {"watch", "episode", "episodes", "play"}
_DIGITS = re.compile(r"^\d{1,5}$")
_SEASON_EPISODE = re.compile(
    r"(?:^|[-_])s(?:eason)?[-_]?0*(\d+)[-_]?e(?:p(?:isode)?)?[-_]?0*(\d+)$",
    re.I,
)
_EPISODE_MARKER = re.compile(r"(?:^|[-_])(?:ep|episode)[-_]?0*(\d+)$", re.I)
_SEASON_MARKER = re.compile(r"(?:^|[-_])(?:season|s)[-_]?0*(\d+)$", re.I)


def _number(raw: str) -> Optional[int]:
    value = unquote_plus(raw).strip()
    if not _DIGITS.fullmatch(value):
        return None
    parsed = int(value)
    return parsed if parsed > 0 else None


def _query_value(query: str, keys: tuple[str, ...]) -> Optional[Dict[str, Any]]:
    pieces = query.split("&") if query else []
    for wanted in keys:
        matches = []
        for index, piece in enumerate(pieces):
            raw_key, separator, raw_value = piece.partition("=")
            if unquote_plus(raw_key).lower() == wanted:
                matches.append((index, raw_value if separator else ""))
        if not matches:
            continue
        # Duplicated keys are not a trustworthy locator, even if one value
        # happens to look numeric.
        if len(matches) != 1:
            return {"ambiguous": True, "source": f"query:{wanted}"}
        index, raw_value = matches[0]
        parsed = _number(raw_value)
        if parsed is not None:
            return {"value": parsed, "source": f"query:{wanted}", "locator": ("query", index)}
    return None


def _path_season(parts: list[str]) -> Optional[int]:
    for raw in reversed(parts):
        segment = unquote(raw)
        match = _SEASON_MARKER.search(segment)
        if match:
            return _number(match.group(1))
        match = _SEASON_EPISODE.search(segment)
        if match:
            return _number(match.group(1))
    return None


def _path_episode(parts: list[str]) -> Optional[Dict[str, Any]]:
    decoded = [unquote(part) for part in parts]
    season = _path_season(parts)

    for index in range(len(decoded) - 1, -1, -1):
        segment = decoded[index]
        season_episode = _SEASON_EPISODE.search(segment)
        if season_episode:
            episode = _number(season_episode.group(2))
            if episode is not None:
                return {
                    "episode": episode, "season": _number(season_episode.group(1)),
                    "source": "path:season-episode", "locator": ("season_episode", index),
                }
        marker = _EPISODE_MARKER.search(segment)
        if marker:
            episode = _number(marker.group(1))
            if episode is not None:
                return {
                    "episode": episode, "season": season,
                    "source": "path:episode-marker", "locator": ("episode_marker", index),
                }

    if len(decoded) >= 2 and decoded[-2].lower() in {"ep", "episode", "episodes"}:
        episode = _number(decoded[-1])
        if episode is not None:
            return {
                "episode": episode, "season": season,
                "source": "path:episode-marker", "locator": ("path_segment", len(parts) - 1),
            }

    # ``path.split('/')`` starts with an empty element for absolute paths and
    # may end with one for a trailing slash; retain the original index so a
    # rewrite preserves that slash while inspecting only real segments.
    nonempty = [(index, segment) for index, segment in enumerate(decoded) if segment]
    root = nonempty[0][1].lower() if nonempty else ""
    if root in _WATCH_ROUTE_ROOTS and len(nonempty) >= 3:
        last_index, last_segment = nonempty[-1]
        episode = _number(last_segment)
        if episode is not None:
            return {
                "episode": episode, "season": season,
                "source": "path:trailing-number", "locator": ("path_segment", last_index),
            }
    return None


def _episode_url_info(url: str) -> Dict[str, Any]:
    """Return the episode and exact URL locator, if this route makes one clear."""
    try:
        parsed = urlsplit(url)
    except (TypeError, ValueError):
        return {"season": None, "episode": None, "source": "", "locator": None}

    season_query = _query_value(parsed.query, _SEASON_QUERY_KEYS)
    season = season_query.get("value") if season_query else None
    query_episode = _query_value(parsed.query, _EPISODE_QUERY_KEYS)
    if query_episode and query_episode.get("ambiguous"):
        return {
            "season": season if season is not None else _path_season(parsed.path.split("/")),
            "episode": None, "source": "ambiguous-url", "locator": None,
        }
    if query_episode:
        return {
            "season": season if season is not None else _path_season(parsed.path.split("/")),
            "episode": query_episode["value"], "source": query_episode["source"],
            "locator": query_episode["locator"],
        }

    path_episode = _path_episode(parsed.path.split("/"))
    if path_episode:
        return {
            "season": season if season is not None else path_episode["season"],
            "episode": path_episode["episode"], "source": path_episode["source"],
            "locator": path_episode["locator"],
        }
    return {"season": season if season is not None else _path_season(parsed.path.split("/")),
            "episode": None, "source": "", "locator": None}


def parse_episode_url(url: str) -> Dict[str, Any]:
    """Public title-independent hint parser used by anchor matching and tests."""
    info = _episode_url_info(url)
    source = info["source"]
    confidence = "high" if source.startswith("query:") or source == "path:episode-marker" else (
        "medium" if info["episode"] is not None else "none"
    )
    return {
        "season": info["season"], "episode": info["episode"],
        "source": source, "confidence": confidence,
    }


async def learn_watch_site(
    user_id: int, entry_id: int, page_url: str, season: Optional[int], episode: Optional[int]
) -> None:
    """Upsert (user, entry, domain) from a title match; failure is best effort."""
    if not page_url:
        return
    key = await vault.get(user_id)
    if key is None:
        return
    domain = _normalize(page_url)
    if not domain or "." not in domain:
        return
    # URL evidence is more reliable than a title suffix. This also supports
    # extension versions that have not yet sent explicit episode hints.
    hint = _episode_url_info(page_url)
    if hint["episode"] is not None:
        episode = hint["episode"]
        if hint["season"] is not None:
            season = hint["season"]
    try:
        pool = await get_pool()
        async with pool.acquire() as con:
            await con.execute(
                "INSERT INTO ani_watch_sites (user_id, entry_id, domain_enc, domain_hash, "
                "url_enc, season, episode) VALUES ($1, $2, $3, $4, $5, $6, $7) "
                "ON CONFLICT (user_id, entry_id, domain_hash) DO UPDATE SET "
                "url_enc = EXCLUDED.url_enc, season = EXCLUDED.season, "
                "episode = EXCLUDED.episode, use_count = ani_watch_sites.use_count + 1, "
                "last_used_at = now()",
                user_id, entry_id, encrypt(key, domain), index_hash(key, domain),
                encrypt(key, page_url), season, episode,
            )
    except Exception:
        return


def _pad_like(value: str, new_number: int) -> str:
    return str(new_number).zfill(len(value)) if value.startswith("0") else str(new_number)


def _replace_episode_at(url: str, locator: tuple[str, int], new_episode: int) -> Optional[str]:
    parts = urlsplit(url)
    kind, index = locator
    if kind == "query":
        query = parts.query.split("&") if parts.query else []
        if index >= len(query):
            return None
        raw_key, separator, raw_value = query[index].partition("=")
        if not separator or _number(raw_value) is None:
            return None
        query[index] = f"{raw_key}={_pad_like(raw_value, new_episode)}"
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(query), parts.fragment))

    path = parts.path.split("/")
    if index >= len(path):
        return None
    raw_segment = path[index]
    if kind == "path_segment":
        if _number(raw_segment) is None:
            return None
        path[index] = _pad_like(raw_segment, new_episode)
    elif kind == "episode_marker":
        match = re.search(r"(?i)((?:^|[-_])(?:ep|episode)[-_]?)(0*\d+)$", raw_segment)
        if not match:
            return None
        path[index] = raw_segment[:match.start(2)] + _pad_like(match.group(2), new_episode)
    elif kind == "season_episode":
        match = re.search(
            r"(?i)((?:^|[-_])s(?:eason)?[-_]?0*\d+[-_]?e(?:p(?:isode)?)?[-_]?)(0*\d+)$",
            raw_segment,
        )
        if not match:
            return None
        path[index] = raw_segment[:match.start(2)] + _pad_like(match.group(2), new_episode)
    else:
        return None
    return urlunsplit((parts.scheme, parts.netloc, "/".join(path), parts.query, parts.fragment))


def _retarget(
    url: str, old_s: Optional[int], old_e: Optional[int], new_s: int, new_e: int
) -> Optional[str]:
    """Rewrite only a recognized season/episode locator; None means unsafe."""
    out = url
    if old_s and old_s != new_s:
        season_pat = re.compile(rf"(?i)(s(?:eason)?[-_]?)(0*){old_s}(?![\d])")
        out, count = season_pat.subn(
            lambda match: match.group(1) + (
                str(new_s).zfill(len(match.group(2)) + len(str(old_s)))
                if match.group(2) else str(new_s)
            ),
            out,
        )
        if count == 0:
            return None

    info = _episode_url_info(out)
    locator = info.get("locator")
    current_episode = info.get("episode")
    if locator is None or current_episode is None:
        return None
    if old_e is not None and current_episode != old_e:
        return None
    targeted = _replace_episode_at(out, locator, new_e)
    if not targeted or targeted == url:
        return None
    return targeted


async def resolve_watch_link(
    user_id: int, entry_id: int, season: int, episode: int
) -> Result[Optional[str], str]:
    """A learned URL retargeted to a released episode, or its site home."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9)")
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT domain_enc, url_enc, season, episode FROM ani_watch_sites "
            "WHERE user_id = $1 AND entry_id = $2 "
            "ORDER BY use_count DESC, last_used_at DESC",
            user_id, entry_id,
        )
    if not rows:
        return Success(None)
    row = rows[0]
    url = decrypt(key, row["url_enc"]) or ""
    domain = decrypt(key, row["domain_enc"]) or ""
    targeted = _retarget(url, row["season"], row["episode"], season, episode)
    if targeted:
        return Success(targeted)
    return Success(f"https://{domain}" if domain else None)


async def list_watch_sites(user_id: int) -> Result[List[Dict[str, Any]], str]:
    """Return the user's learned anime-site map for extension settings."""
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9)")
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT s.id, s.domain_enc, s.url_enc, s.season, s.episode, "
            "s.use_count, s.last_used_at, e.id AS entry_id, e.title_enc "
            "FROM ani_watch_sites s JOIN ani_entries e ON e.id = s.entry_id "
            "WHERE s.user_id = $1 ORDER BY s.last_used_at DESC",
            user_id,
        )
    return Success([
        {
            "id": row["id"], "entry_id": row["entry_id"],
            "entry_title": decrypt(key, row["title_enc"]),
            "domain": decrypt(key, row["domain_enc"]),
            "url": decrypt(key, row["url_enc"]),
            "season": row["season"], "episode": row["episode"],
            "use_count": row["use_count"],
            "last_used_at": row["last_used_at"].isoformat() if row["last_used_at"] else None,
        }
        for row in rows
    ])


async def delete_watch_site(user_id: int, site_id: int) -> Result[bool, str]:
    pool = await get_pool()
    async with pool.acquire() as con:
        result = await con.execute(
            "DELETE FROM ani_watch_sites WHERE id = $1 AND user_id = $2",
            site_id, user_id,
        )
    if not result.endswith("1"):
        return Failure("learned site not found")
    return Success(True)
