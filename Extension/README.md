# DreaMedia Extension (D55)

Site-agnostic watch tracking + subscribe-from-page, for Chrome (MV3) and Firefox (MV2).

## What it does

1. **Watch tracking (SyncNwatch model)** — the content script finds the playing
   `<video>` on ANY site, and reports the timestamp to DreaMedia every 15s
   (and on pause/ended). Bind the tab to a tracked anime from the popup; an
   ended video advances the episode.
2. **Subscribe from the page (HydraTracker model)** — on any YouTube
   channel/playlist/video page, pick a notification type and subscribe without
   opening DreaMedia. No CSV, ever — the extension talks to the live backend.
3. **Add the current video to a playlist card.**

## Setup

1. In DreaMedia (web): issue an extension token (Settings → Extension). The raw
   token is shown once — copy it.
2. Load the extension:
   - **Chrome/Edge/Brave**: `chrome://extensions` → Developer mode →
     "Load unpacked" → pick `mv3/`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` →
     "Load Temporary Add-on" → pick `mv2/manifest.json`.
3. In the popup: backend URL (`http://127.0.0.1:8000`) + token → Save & ping.

## Files

- `shared/` — the single source of truth (content/popup/background).
- `mv3/`, `mv2/` — built variants (manifest + copies). After editing `shared/`,
  copy the files over both variants.

The background worker/page is the only network lane: content and popup scripts
message it, it calls `http://<backend>/ext/*` with `X-DreaMedia-Token`.
