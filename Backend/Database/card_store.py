"""Manual todo cards (D47) — the Track page's real model.

Non-automated: cards are created by hand, filled with arbitrary video
links, checked off. No polling, no ranks, no feeds touch these tables.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from returns.result import Failure, Result, Success

from Database import vault
from Database.crypto import decrypt, encrypt, index_hash
from Database.db import get_pool


class CardStore:
    async def create_card(self, user_id: int, name: str) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            card_id = await con.fetchval(
                "INSERT INTO yt_cards (user_id, name_enc) VALUES ($1, $2) RETURNING id",
                user_id, encrypt(key, name),
            )
        return Success(card_id)

    async def list_cards(self, user_id: int) -> List[Dict[str, Any]]:
        key = await vault.get(user_id)
        if key is None:
            return []
        pool = await get_pool()
        async with pool.acquire() as con:
            cards = await con.fetch(
                "SELECT id, name_enc, created_at FROM yt_cards WHERE user_id = $1 ORDER BY id",
                user_id,
            )
            result = []
            for c in cards:
                items = await con.fetch(
                    "SELECT id, video_id, url_enc, title_enc, thumbnail_enc, done, added_at "
                    "FROM yt_card_items WHERE card_id = $1 ORDER BY position, id",
                    c["id"],
                )
                result.append({
                    "id": c["id"],
                    "name": decrypt(key, c["name_enc"]),
                    "created_at": c["created_at"].isoformat(),
                    "total": len(items),
                    "done": sum(1 for i in items if i["done"]),
                    "items": [
                        {
                            "id": i["id"],
                            "video_id": i["video_id"],
                            "url": decrypt(key, i["url_enc"]),
                            "title": decrypt(key, i["title_enc"]),
                            "thumbnail": decrypt(key, i["thumbnail_enc"]),
                            "done": i["done"],
                            "added_at": i["added_at"].isoformat(),
                        }
                        for i in items
                    ],
                })
        return result

    async def delete_card(self, user_id: int, card_id: int) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM yt_cards WHERE id = $1 AND user_id = $2", card_id, user_id
            )
        if result.endswith("0"):
            return Failure("card not found")
        return Success({"deleted": card_id})

    async def add_item(
        self, user_id: int, card_id: int, video_id: str, url: str, title: str,
        thumbnail: Optional[str],
    ) -> Result[int, str]:
        key = await vault.get(user_id)
        if key is None:
            return Failure("vault locked (D9)")
        pool = await get_pool()
        async with pool.acquire() as con:
            owner = await con.fetchval(
                "SELECT 1 FROM yt_cards WHERE id = $1 AND user_id = $2", card_id, user_id
            )
            if not owner:
                return Failure("card not found")
            position = await con.fetchval(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM yt_card_items WHERE card_id = $1",
                card_id,
            )
            item_id = await con.fetchval(
                "INSERT INTO yt_card_items (card_id, video_id, url_enc, url_hash, title_enc, thumbnail_enc, position) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7) "
                "ON CONFLICT (card_id, url_hash) DO UPDATE SET card_id = EXCLUDED.card_id "
                "RETURNING id",
                card_id, video_id, encrypt(key, url), index_hash(key, url),
                encrypt(key, title), encrypt(key, thumbnail) if thumbnail else None, position,
            )
        return Success(item_id)

    async def set_item_done(
        self, user_id: int, item_id: int, done: bool
    ) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "UPDATE yt_card_items i SET done = $3 FROM yt_cards c "
                "WHERE c.id = i.card_id AND c.user_id = $1 AND i.id = $2",
                user_id, item_id, done,
            )
        if result.endswith("0"):
            return Failure("item not found")
        return Success({"id": item_id, "done": done})

    async def delete_item(self, user_id: int, item_id: int) -> Result[Dict[str, Any], str]:
        pool = await get_pool()
        async with pool.acquire() as con:
            result = await con.execute(
                "DELETE FROM yt_card_items i USING yt_cards c "
                "WHERE c.id = i.card_id AND c.user_id = $1 AND i.id = $2",
                user_id, item_id,
            )
        if result.endswith("0"):
            return Failure("item not found")
        return Success({"deleted": item_id})
