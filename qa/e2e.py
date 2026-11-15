"""Browser end-to-end checks for a running DreaMedia stack.

The script drives the real UI with Playwright (no mocks, no stubbed GraphQL):
it signs in as the demo user, creates and renames a domain, adds a muted
subdomain, attaches the domain to a channel and mutes the channel, moves an
anime between watch states, builds a todo playlist from video links, advances
the episode queue, proves the browser-facing bridge path refuses forged bell
pushes, pushes one message through the internal bridge port, and confirms the
bell renders it and can mark it read.

Usage (stack already running via start.py):

    python3 qa/e2e.py                 # http://127.0.0.1:3000
    DREAMEDIA_URL=http://host:3000 python3 qa/e2e.py

Needs `pip install playwright` and a Chromium build (`playwright install
chromium`, or a system chromium at /usr/bin/chromium).
"""

import asyncio
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

BASE = os.environ.get("DREAMEDIA_URL", "http://127.0.0.1:3000").rstrip("/")
# The bridge listens on an internal-only port: only the backend may push.
BRIDGE = os.environ.get("DREAMEDIA_BRIDGE_URL", "http://127.0.0.1:3100").rstrip("/")
OUT = Path(__file__).resolve().parent / "shots"
CHECK: list[tuple[str, bool]] = []


def chromium_path() -> str | None:
    for candidate in ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"):
        if os.path.exists(candidate):
            return candidate
    return None  # fall back to Playwright's own download


def ok(name: str, condition: bool, extra: str = "") -> None:
    CHECK.append((name, bool(condition)))
    print(("PASS " if condition else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chromium_path(), args=["--no-sandbox"])
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(BASE, wait_until="networkidle")
        await page.fill("input[placeholder='your-handle']", "demo")
        await page.fill("input[type=password]", "demo1234")
        await page.click("form.auth-card button.btn--primary")
        await page.wait_for_selector(".rail", timeout=15000)
        ok("login", True)

        # -------- categories: create / rename / subdomain mute
        await page.goto(f"{BASE}/sources", wait_until="networkidle")
        await page.get_by_role("button", name="Categories").click()
        first_section = page.locator("section").first
        stamp = time.strftime("%H%M%S")
        await first_section.locator("input[placeholder='New domain']").fill(f"QA Domain {stamp}")
        await first_section.get_by_role("button", name="Domain", exact=True).click()
        await page.wait_for_timeout(1200)
        card = page.locator(".domain-card", has_text=f"QA Domain {stamp}")
        ok("domain created", await card.count() == 1)

        await card.get_by_role("button", name="Rename domain").click()
        await page.wait_for_timeout(300)
        edit = page.locator(".domain-card__head input").first
        await edit.fill(f"QA Renamed {stamp}")
        await edit.press("Enter")
        await page.wait_for_timeout(1200)
        renamed = page.locator(".domain-card", has_text=f"QA Renamed {stamp}")
        ok("domain renamed", await renamed.count() == 1)

        await renamed.locator("input[placeholder='New subdomain']").fill(f"Muted sub {stamp}")
        await renamed.locator(".sub-add .btn").click()
        await page.wait_for_timeout(1200)
        sub_row = page.locator(".sub-row", has_text=f"Muted sub {stamp}")
        ok("subdomain created", await sub_row.count() == 1)
        await sub_row.locator(".mini-switch").click()
        await page.wait_for_timeout(1000)
        ok("subdomain muted", await sub_row.locator(".mini-switch").get_attribute("aria-checked") == "false")
        await page.screenshot(path=str(OUT / "10-categories-qa.png"), full_page=True)

        # mute the whole new domain too
        await renamed.locator(".domain-card__head .icon-btn").first.click()
        await page.wait_for_timeout(800)

        # -------- channels: attach + mute
        await page.get_by_role("button", name="Channels").click()
        await page.wait_for_timeout(500)
        await page.locator(".ch-row").first.get_by_role("button", name="Edit source").click()
        await page.wait_for_timeout(500)
        editor = page.locator(".row-editor").first
        select = editor.locator("select").nth(1)  # attach select after type
        options = await select.locator("option").all_inner_texts()
        target = next((o for o in options if "QA Renamed" in o), None)
        if target:
            await select.select_option(label=target)
            await page.wait_for_timeout(1200)
            ok("channel attached", "QA Renamed" in await page.locator(".ch-row").first.inner_text())
        else:
            ok("channel attached", False, "no QA option")

        await page.locator(".ch-row").first.locator(".switch").click()
        await page.wait_for_timeout(1200)
        ok("channel muted", "MUTED" in await page.locator(".ch-row").first.inner_text())
        await page.screenshot(path=str(OUT / "11-channels-qa.png"), full_page=True)
        # unmute again so demo data stays clean
        await page.locator(".ch-row").first.locator(".switch").click()
        await page.wait_for_timeout(1000)

        # -------- anime: list change + season panel
        await page.get_by_role("button", name="Anime").first.click()
        await page.wait_for_timeout(700)
        anime_card = page.locator(".ani-card").first
        await anime_card.locator(".ani-controls select").first.select_option("watchlist")
        await page.wait_for_timeout(1400)
        ok("anime list updated", "Watchlist" in await anime_card.inner_text())
        await anime_card.get_by_role("button", name="Seasons").click()
        await page.wait_for_timeout(600)
        ok("season panel", await page.locator(".ani-detail").count() == 1)
        await page.screenshot(path=str(OUT / "12-anime-qa.png"), full_page=True)
        await page.locator(".ani-card").first.locator(".ani-controls select").first.select_option("watching")
        await page.wait_for_timeout(900)

        # -------- todo: create playlist + add links
        await page.goto(f"{BASE}/todo", wait_until="networkidle")
        pl_name = "QA playlist " + str(int(asyncio.get_event_loop().time()))
        await page.fill("input[placeholder='New playlist name']", pl_name)
        await page.get_by_role("button", name="Playlist", exact=True).click()
        await page.wait_for_timeout(2000)
        pl = page.locator(".playlist-card").last
        ok("playlist created", await pl.count() == 1)
        await pl.locator("input[placeholder*='Paste links']").fill(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ, https://youtu.be/9bZkp7q19f0"
        )
        await pl.get_by_role("button", name="Add", exact=True).click()
        await page.wait_for_timeout(1800)
        items = await pl.locator(".pl-item").count()
        ok("playlist items added", items >= 2, f"count={items}")
        await pl.locator(".pl-item .check").first.click()
        await page.wait_for_timeout(1200)
        ok("playlist item checked", await pl.locator(".pl-item .check").first.get_attribute("data-checked") == "true")
        await page.screenshot(path=str(OUT / "13-todo-qa.png"), full_page=True)

        # queue +1 episode
        qc = page.locator(".queue-card", has=page.get_by_role("button", name="+1 episode")).first
        before = await qc.inner_text()
        await qc.get_by_role("button", name="+1 episode").click()
        await page.wait_for_timeout(1400)
        after = await qc.inner_text()
        ok("queue cursor advanced", before != after, after.split("\n")[2][:40] if "\n" in after else "")

        # -------- bridge push -> bell
        viewer = await page.evaluate(
            """async () => {
              const r = await fetch('/graphql', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({query:'{ viewer { id } }'})});
              return (await r.json()).data.viewer.id;
            }"""
        )
        payload = json.dumps(
            {
                "id": "e2e-bridge-1",
                "rowId": 999,
                "userId": viewer,
                "media": "ani",
                "kind": "release_confirmed",
                "title": "Bridge smoke test",
                "message": "Release confirmed · Season 2",
                "level": "release",
                "createdAt": "2026-11-14T16:00:00+00:00",
                "payload": {"entryId": 1},
            }
        ).encode()
        # The backend pushes to the bridge's internal port; the browser-facing
        # /bridge/ path must refuse pushes so the bell stays backend-exclusive.
        forged = urllib.request.Request(
            f"{BASE}/bridge/api/notifications",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(forged)
            forged_status = 200
        except urllib.error.HTTPError as exc:
            forged_status = exc.code
        ok("browser cannot forge a bell push", forged_status == 403, str(forged_status))

        req = urllib.request.Request(
            f"{BRIDGE}/api/notifications",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as resp:
            ok("bridge accepted push", resp.status == 202, str(resp.status))

        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(1500)
        await page.locator(".bell").first.click()
        await page.wait_for_timeout(1200)
        ok("bell shows pushed message", await page.locator(".bell-item", has_text="Bridge smoke test").count() == 1)
        await page.screenshot(path=str(OUT / "14-bell-qa.png"))
        await page.get_by_role("button", name="Mark all read").click()
        await page.wait_for_timeout(1200)
        ok("bell mark all read", "0 new" in (await page.locator(".bell-panel__head").inner_text()).lower())

        ok("no page errors", not errors, "; ".join(errors[:3]))

        print("\nSUMMARY", sum(1 for _, v in CHECK if v), "/", len(CHECK))
        await browser.close()
        if not all(v for _, v in CHECK):
            raise SystemExit(1)


asyncio.run(main())
