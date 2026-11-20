"""Anchor detection (ext v2 phase 3): match page-title candidates against
the user's tracked anime — server-side, never in the extension.

The anime module sends raw candidates (document.title, og:title, h1). We
split them into segments, pull season/episode numbers out, and fuzzy-match
the cleaned title against entry + season titles (AniList chains name later
seasons differently — "Naruto" vs "Naruto Shippuden"). On a unique match
the extension auto-binds the tab and live tracking starts; the popup's
manual binding always wins because the module only anchors when unbound.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt
from Database.db import get_pool
from Extension import sites

# " - ", " | ", " – ", " — ", " · " split page titles into meaningful segments
# ("One Piece Ep 1230 - Watch on SiteName" -> "One Piece Ep 1230").
_SPLIT = re.compile(r"\s*[-|–—·•]\s*|\s{2,}")
_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")

_SE = re.compile(r"\bs(?:eason)?\s*(\d{1,2})\s*[ex]\s*(?:p(?:isode)?\s*)?(\d{1,4})\b", re.I)
_SEASON_ONLY = re.compile(r"\bseason\s*(\d{1,2})\b", re.I)
_EPISODE = re.compile(r"\b(?:episode|ep)\s*\.?\s*(\d{1,4})\b", re.I)
_TRAILING_NUM = re.compile(r"\b(\d{1,4})\s*$")


_VOWEL_FOLDS = re.compile(r"uu|oo|aa|ii|ee|ou")


def _fold_vowels(match: re.Match) -> str:
    group = match.group(0)
    return group[0]


def _norm(text: str) -> str:
    """Lowercase, alnum+space only, collapsed — comparison form. Romaji
    long vowels fold ('shippuuden' == 'shippuden', 'toukyou' == 'tokyo'):
    AniList stores romaji, pages write the common spelling."""
    base = _WS.sub(" ", _NON_ALNUM.sub(" ", text.lower())).strip()
    return _VOWEL_FOLDS.sub(_fold_vowels, base)


def _segments(candidate: str) -> List[str]:
    parts = [_norm(p) for p in _SPLIT.split(candidate)]
    return [p for p in parts if len(p) >= 3]


def _parse(segment: str) -> Dict[str, Optional[int] | str]:
    """Pull (season, episode) out of a normalized segment; the remainder is
    the title part. 's3e4', 'season 3 episode 4', 'ep 4', 'episode 4', and
    the trailing bare number of 'one piece 1230' are all recognized.
    Season is claimed before the bare-number rule so 'bleach season 2' is
    not misread as episode 2."""
    title = segment
    season: Optional[int] = None
    episode: Optional[int] = None
    m = _SE.search(segment)
    if m:
        season, episode = int(m.group(1)), int(m.group(2))
        title = (segment[: m.start()] + " " + segment[m.end():]).strip()
    else:
        ms = _SEASON_ONLY.search(segment)
        if ms:
            season = int(ms.group(1))
            title = (segment[: ms.start()] + " " + segment[ms.end():]).strip()
        m = _EPISODE.search(title)
        if m:
            episode = int(m.group(1))
            title = (title[: m.start()] + " " + title[m.end():]).strip()
        else:
            m = _TRAILING_NUM.search(title)
            if m:
                episode = int(m.group(1))
                title = title[: m.start()].strip()
    return {"title": _WS.sub(" ", title).strip(), "season": season, "episode": episode}


def _title_hits(key: str, title: str) -> int:
    """Containment score between a cleaned segment and a tracked title.
    3 = exact, 2 = title inside segment (page adds words), 1 = segment
    inside title (partial page title). 0 = no match. Word-boundary safe."""
    if not key or not title:
        return 0
    if key == title:
        return 3
    if len(title) >= 3 and re.search(rf"\b{re.escape(title)}\b", key):
        return 2
    if len(key) >= 5 and re.search(rf"\b{re.escape(key)}\b", title):
        return 1
    return 0


def _best_match(
    candidates: List[str], entries: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Unique best (entry, season, episode) across all candidate segments.
    Ambiguity (two entries scoring the same) returns None — never bind
    wrong."""
    best: Optional[Dict[str, Any]] = None
    best_score = 0
    ambiguous = False
    for candidate in candidates:
        for segment in _segments(candidate):
            parsed = _parse(segment)
            key = parsed["title"]
            if len(str(key)) < 3:
                continue
            for entry in entries:
                for title, season_no in entry["titles"]:
                    score = _title_hits(str(key), title)
                    if score == 0:
                        continue
                    # Longer title wins ties: "naruto shippuden" over "naruto".
                    rank = (score, len(title))
                    if best is None or rank > (best_score, len(best["matched"])):
                        ambiguous = False  # strictly better — old ties are beaten
                        best = {
                            "entry_id": entry["id"],
                            "season": parsed["season"],
                            "episode": parsed["episode"],
                            "matched": title,
                            "matched_season": season_no,
                            "cursor_season": entry["cursor_season"],
                            "cursor_episode": entry["cursor_episode"],
                            "blocked": entry.get("blocked", False),
                            "reason": entry.get("reason"),
                            "seasons": entry["seasons"],
                        }
                        best_score = score
                    elif (score, len(title)) == (best_score, len(best["matched"])) and best["entry_id"] != entry["id"]:
                        ambiguous = True
    if best is None or ambiguous:
        return None
    # The page gave no season, but the title it matched belongs to a known
    # season of the chain — 'naruto shippuden' implies S2.
    if best["season"] is None and best.get("matched_season"):
        best["season"] = best["matched_season"]
    return best


def _resolve_absolute(best: Dict[str, Any]) -> None:
    """'one piece 1230' gives an absolute episode with no season. Walk the
    chain's episode counts to place it; mutates best in place when the
    mapping is unambiguous."""
    if best["season"] is not None or best["episode"] is None:
        return
    remaining = best["episode"]
    for season_no, total in best["seasons"]:
        if total is None:
            break
        if remaining <= total:
            best["season"] = season_no
            best["episode"] = remaining
            return
        remaining -= total


async def anchor_match(
    user_id: int, candidates: List[str], page_url: str = ""
) -> Result[Optional[Dict[str, Any]], str]:
    """Match page candidates against the user's tracked entries. None means
    'nothing tracked here' — the module stays unbound, no error."""
    if not candidates:
        return Success(None)
    key = await vault.get(user_id)
    if key is None:
        return Failure("vault locked (D9)")
    pool = await get_pool()
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT id, title_enc, cursor_season, cursor_episode, label, label_reason_enc "
            "FROM ani_entries WHERE user_id = $1",
            user_id,
        )
        season_rows = await con.fetch(
            "SELECT s.entry_id, s.season_no, s.title_enc, s.episodes_total "
            "FROM ani_seasons s JOIN ani_entries e ON e.id = s.entry_id "
            "WHERE e.user_id = $1",
            user_id,
        )
    entries: List[Dict[str, Any]] = []
    by_id: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        entry = {
            "id": r["id"],
            # (normalized title, season it names) — season titles know their
            # season; the entry title implies none (absolute numbers walk the
            # chain instead, so 'naruto ep 300' lands in S2, not S1E300).
            "titles": [t for t in [(_norm(decrypt(key, r["title_enc"]) or ""), None)] if t[0]],
            "cursor_season": r["cursor_season"],
            "cursor_episode": r["cursor_episode"],
            "blocked": r["label"] == "blocked",
            "reason": decrypt(key, r["label_reason_enc"]) if r["label_reason_enc"] else None,
            "seasons": [],
        }
        entries.append(entry)
        by_id[r["id"]] = entry
    for s in season_rows:
        entry = by_id.get(s["entry_id"])
        if entry is None:
            continue
        title = _norm(decrypt(key, s["title_enc"]) or "")
        if title and title not in [t for t, _ in entry["titles"]]:
            entry["titles"].append((title, s["season_no"]))
        entry["seasons"].append((s["season_no"], s["episodes_total"]))
    for entry in entries:
        entry["seasons"].sort()

    best = _best_match(candidates, entries)
    if best is None:
        return Success(None)
    _resolve_absolute(best)
    best.pop("matched", None)
    best.pop("matched_season", None)
    best.pop("seasons", None)
    # Phase 5: learn the watch site passively from this report (never for
    # blocked entries — the disclaimer path is not a watch session).
    if not best["blocked"]:
        await sites.learn_watch_site(
            user_id, best["entry_id"], page_url, best["season"], best["episode"]
        )
    return Success(best)
