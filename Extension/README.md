# DreaMedia Extension (D55)

Site-agnostic watch tracking + subscribe-from-page, for Chrome (MV3) and Firefox (MV2).

## What it does

1. **Watch tracking (SyncNwatch model)** — the content script finds the playing
   `<video>` on enabled sites, and reports the timestamp to DreaMedia every 15s
   (and on pause/ended). Bind the tab to a tracked anime from the popup; an
   ended video advances the episode.
2. **Subscribe from the page (HydraTracker model)** — add a YouTube channel or
   playlist to your feed without opening DreaMedia. The backend resolves the
   active tab’s URL.
3. **Add the current video to a playlist card.**

## Setup

1. In DreaMedia (web): open **Ext → Token** and select **Issue new token**. The raw
   token is shown once — copy it.
2. Load the extension:
   - **Chrome/Edge/Brave**: `chrome://extensions` → Developer mode →
     "Load unpacked" → pick `mv3/`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` →
     "Load Temporary Add-on" → pick `mv2/manifest.json`.
3. Open the popup’s **Connection settings** (gear icon). Enter your backend
   URL (`http://127.0.0.1:8123` by default) and token, then select **Save & ping**.

## Popup

- **Current site** shows whether the site is enabled, paused, or not enabled.
  Add a new site as Anime or YouTube, then reload its tab. Manage paused
  sites in **Ext → Sites** in DreaMedia.
- **Source** follows a YouTube channel (Track, WordScan, or Random) or a page
  with a playlist link (Playlist).
- **Save video** adds the active YouTube video to a custom playlist in Todo.
- **Bind anime** lets you manually link the tab to a tracked anime and set the
  season and episode. It does not replace automatic matching on enabled sites.

This directory replaces `Extension/` in DreaMedia. `mv2/` and `mv3/` are
ready to load without a frontend build. The surrounding Make project is a
preview with sample data and is not needed by either browser package.
The UI uses the dark zinc theme, `d/m` mark, and terminology from DreaMedia’s
current frontend (upstream revision `a906e3f`). See `LICENSE`
for the original AGPL-3.0 license.

## Files

- `shared/` — the single source of truth (content/popup/background).
- `mv3/`, `mv2/` — built variants (manifest + copies). After editing `shared/`,
  copy the files over both variants.

The background worker/page is the only network lane: content and popup scripts
message it, it calls `http://<backend>/ext/*` with `X-DreaMedia-Token`.
