"""Break-glass admin tool — for a box that has no reachable admin account.

The admin page can promote people, but if nobody is admin (restored dump,
deleted account, forgotten which signup was first) the page is unreachable.
Run this inside the backend container:

    docker compose exec backend python -m scripts.admin list
    docker compose exec backend python -m scripts.admin promote alice

It is a deliberate shell-only escape hatch: no HTTP route, no GraphQL field.
"""
from __future__ import annotations

import asyncio
import sys

from returns.result import Failure

from Admin import users
from Database import db


async def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("list", "promote", "demote"):
        print(__doc__)
        return 2
    await db.migrate()
    if argv[0] == "list":
        for row in await users.list_users():
            print(f"{row['id']:>4}  {row['username']:<24} {row['role']:<6} {row['createdAt']}")
        return 0
    if len(argv) != 2:
        print("usage: python -m scripts.admin promote|demote <username>")
        return 2
    username, target = argv[1], ("admin" if argv[0] == "promote" else "user")
    pool = await db.get_pool()
    async with pool.acquire() as con:
        user_id = await con.fetchval("SELECT id FROM users WHERE username = $1", username)
    if user_id is None:
        print(f"no such user: {username}")
        return 1
    result = await users.set_role(0, user_id, target)  # actor 0 = no self-guard
    await db.close()
    if isinstance(result, Failure):
        print(f"failed: {result.failure()}")
        return 1
    print(f"{username} is now {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
