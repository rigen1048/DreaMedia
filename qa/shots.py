"""Capture the docs screenshots from a running stack.

    python3 qa/shots.py            # writes into qa/shots/
    DREAMEDIA_URL=http://host:8124 python3 qa/shots.py

The stack must already be seeded (`python -m scripts.seed_demo` in the backend
container) so the demo login `demo` / `demo1234` has data to show.
"""

import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright

BASE = os.environ.get("DREAMEDIA_URL", "http://127.0.0.1:8124").rstrip("/")
OUT = Path(__file__).resolve().parent / "shots"


def chromium_path() -> str | None:
    for candidate in ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"):
        if os.path.exists(candidate):
            return candidate
    return None


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chromium_path(), args=["--no-sandbox"])
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = await ctx.new_page()
        errors: list[str] = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        await page.goto(BASE, wait_until="networkidle")
        await page.screenshot(path=str(OUT / "00-login.png"))

        await page.fill("input[placeholder='your-handle']", "demo")
        await page.fill("input[type=password]", "demo1234")
        await page.click("form.auth-card button.btn--primary")
        await page.wait_for_timeout(3000)

        await page.screenshot(path=str(OUT / "01-notifications.png"), full_page=True)

        await page.goto(f"{BASE}/sources", wait_until="networkidle")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(OUT / "02-management-channels.png"), full_page=True)

        await page.get_by_role("button", name="Categories").click()
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(OUT / "03-categories.png"), full_page=True)

        await page.get_by_role("button", name="Anime").first.click()
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(OUT / "04-anime.png"), full_page=True)

        await page.locator(".ani-card").first.get_by_role("button", name="Seasons").click()
        await page.wait_for_timeout(600)
        await page.screenshot(path=str(OUT / "04b-anime-expanded.png"), full_page=True)

        await page.get_by_role("button", name="Blocked", exact=True).click()
        await page.wait_for_timeout(600)
        await page.screenshot(path=str(OUT / "05-blocked.png"), full_page=True)

        await page.goto(f"{BASE}/todo", wait_until="networkidle")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(OUT / "06-todo.png"), full_page=True)

        tile = page.locator(".playlist-tile").first
        if await tile.count():
            await tile.click()
            await page.wait_for_timeout(700)
            await page.screenshot(path=str(OUT / "06b-todo-drawer.png"))
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(300)

        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(1000)
        bell = page.locator(".bell")
        if await bell.count():
            await bell.first.click()
            await page.wait_for_timeout(800)
            await page.screenshot(path=str(OUT / "07-bell.png"))

        # Admin (only reachable for the admin role; the demo account is one).
        if await page.get_by_role("button", name="Admin").count():
            await page.get_by_role("button", name="Admin").click()
            await page.wait_for_selector(".table", timeout=15000)
            if await page.get_by_role("button", name="Back up now").count():
                await page.get_by_role("button", name="Back up now").click()
                await page.wait_for_timeout(4000)
            await page.screenshot(path=str(OUT / "09-admin-backups.png"), full_page=True)
            await page.locator(".chipbtn", has_text="Restore").first.click()
            await page.wait_for_timeout(600)
            await page.screenshot(path=str(OUT / "09b-admin-restore.png"), full_page=True)
            await page.locator(".chipbtn", has_text="Users").first.click()
            await page.wait_for_timeout(500)
            await page.screenshot(path=str(OUT / "09c-admin-users.png"), full_page=True)
            await page.locator(".chipbtn", has_text="Settings").first.click()
            await page.wait_for_timeout(400)
            await page.screenshot(path=str(OUT / "09d-admin-settings.png"), full_page=True)

        narrow = await ctx.new_page()
        await narrow.set_viewport_size({"width": 390, "height": 844})
        await narrow.goto(BASE, wait_until="networkidle")
        await narrow.wait_for_timeout(1200)
        await narrow.screenshot(path=str(OUT / "08-narrow.png"))

        print("ERRORS:", errors[:12])
        await browser.close()


asyncio.run(main())
