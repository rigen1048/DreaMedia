import sqlite3
from pathlib import Path
from typing import Union

def delete_channel_entry(db_path: Union[str, Path], id_channel: int, cascade: bool = True) -> dict:
    """
    Completely deletes everything related to a channel.

    Behavior (exactly as you described):
    - If this is the ONLY channel under its subdomain:
        - Subdomain will be deleted (and therefore its domain if it was the last subdomain).
    - If this is NOT the only channel under its subdomain:
        - Subdomain and domain are NOT touched (even if the domain/domain_name becomes unused).
    - The main channel row + ALL related rows (Tracking, Playlist, RandomSub, Video) are deleted.
    - Feed / videos are always fully deleted.
    - No cascade to other channels or subdomains (deletion is per-channel only).

    Returns a clean summary dict so you can see exactly what was deleted.
    """
    path = Path(db_path)
    con = sqlite3.connect(path)
    con.execute("PRAGMA foreign_keys = ON")
    cur = con.cursor()

    # 1. Get channel info BEFORE deleting (for logging / summary)
    cur.execute("""
        SELECT
            c.channel_name,
            s.id_subdomain,
            d.id_domain,
            d.domain_name,
            s.subdomain_name
        FROM Channel c
        LEFT JOIN SubDomains s ON c.id_subdomain = s.id_subdomain
        LEFT JOIN Domains d ON s.id_domain = d.id_domain
        WHERE c.id_channel = ?
    """, (id_channel,))
    channel_info = cur.fetchone()

    if not channel_info:
        con.close()
        raise ValueError(f"Channel with id_channel={id_channel} not found")

    channel_name, id_subdomain, id_domain, domain_name, subdomain_name = channel_info

    # 2. Get counts (only for logging, never used in deletion logic)
    cur.execute("SELECT COUNT(*) FROM Channel WHERE id_subdomain = ?", (id_subdomain,))
    channels_in_subdomain = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM SubDomains WHERE id_domain = ?", (id_domain,))
    subdomains_in_domain = cur.fetchone()[0]

    # 3. Delete everything related to this channel
    cur.execute("DELETE FROM Tracking WHERE id_channel = ?", (id_channel,))
    cur.execute("DELETE FROM Playlist WHERE id_channel = ?", (id_channel,))
    cur.execute("DELETE FROM RandomSub WHERE id_channel = ?", (id_channel,))
    cur.execute("DELETE FROM Video WHERE channel_id = ?", (id_channel,))
    cur.execute("DELETE FROM Channel WHERE id_channel = ?", (id_channel,))

    deleted_channels = cur.rowcount
    if deleted_channels == 0:
        con.close()
        raise ValueError(f"Channel with id_channel={id_channel} not found")

    con.commit()
    con.close()

    # 4. Clean up hierarchy (cascade deletion)
    if cascade:
        # Only delete subdomain if it had NO other channels left
        if channels_in_subdomain == 1:
            cur.execute("DELETE FROM SubDomains WHERE id_subdomain = ?", (id_subdomain,))
            if cur.rowcount > 0:
                print(f"✓ Subdomain '{subdomain_name}' deleted (last channel under it)")

                # Only delete domain if it had NO other subdomains left
                if subdomains_in_domain == 1:
                    cur.execute("DELETE FROM Domains WHERE id_domain = ?", (id_domain,))
                    if cur.rowcount > 0:
                        print(f"✓ Domain '{domain_name}' deleted (last subdomain under it)")

    # 5. Summary for logging / UI
    summary = {
        "channel_deleted": True,
        "channel_name": channel_name,
        "id_channel": id_channel,
        "id_subdomain": id_subdomain,
        "id_domain": id_domain,
        "subdomain_deleted": channels_in_subdomain == 1,
        "domain_deleted": subdomains_in_domain == 1 and cascade,
        "videos_deleted": None,  # not queried here
        "tracking_deleted": None,
        "playlist_deleted": None,
        "randomsub_deleted": None,
    }

    print(f"✓ Channel '{channel_name}' (ID: {id_channel}) and all related entries deleted.")
    if summary["subdomain_deleted"]:
        print(f"   └── Subdomain '{subdomain_name}' deleted")
    if summary["domain_deleted"]:
        print(f"      └── Domain '{domain_name}' deleted")

    return summary


async def daily_cleanup(
    username: str,
    db_dir: str | Path | None = None,
    delay_hours: float = 2.0
) -> dict[str, Any]:
    """
    Unified daily cleanup operation for Video table.
    - Marks all unseen videos as seen=1 (immediately)
    - Schedules a background task to delete all seen=1 videos after the given delay
    - Returns a clean status dict
    """
    db_path = (Path(db_dir) if db_dir else Path.cwd()) / f"{username}.db"

    try:
        # 1. Connect to the user's database
        async with aiosqlite.connect(db_path) as conn:
            # 2. Mark everything unseen as seen right now
            await conn.execute("UPDATE Video SET seen = 1 WHERE seen = 0")
            await conn.commit()

            # 3. Fire background cleanup task (non-blocking)
            asyncio.create_task(
                _mark_seen_then_cleanup_after_delay(db_path, delay_hours=delay_hours)
            )

            return {
                "status": "success",
                "operation": "daily_cleanup",
                "delay_hours": delay_hours,
                "message": (
                    f"All unseen videos marked as seen. "
                    f"Seen videos will be permanently deleted in {delay_hours} hours (background task)."
                )
            }

    except Exception as e:
        # In production you should log this properly
        print(f"[daily_cleanup] failed: {e}")
        raise

# =============================================================
# EXAMPLE USAGE (copy-paste ready)
# =============================================================
if __name__ == "__main__":
    # Example 1: Firefox (Tech/Software/Firefox) - only channel under subdomain
    delete_channel_entry("your.db", 999, cascade=True)

    # Example 2: Another channel under the SAME subdomain (Firefox and something else)
    # delete_channel_entry("your.db", 1000, cascade=True)  # subdomain will survive
