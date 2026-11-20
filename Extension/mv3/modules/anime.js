/* DreaMedia anime module (ext v2): watch tracking for allowlisted 'ani'
 * domains. Bound by the popup (manual override today; anchor-detection
 * auto-bind is design phase 3). Live-session upserts stream every 5s over
 * the websocket lane; pause/ended merge the final position into the real
 * cursor. Requires core.js. */
(() => {
  const LIVE_INTERVAL_MS = 5000;

  function payload(video) {
    const binding = window.__dreamediaBinding;
    if (!binding || !binding.entryId) return null; // popup binds this tab first
    return {
      entry_id: binding.entryId,
      season: binding.season,
      episode: binding.episode,
      position_seconds: Math.floor(video.currentTime || 0),
    };
  }

  function send(type, body) {
    chrome.runtime.sendMessage({ type, ...body }, () => void chrome.runtime.lastError);
  }

  // ---- anchor detection (phase 3): when unbound, ask the backend what
  // anime this page is; it auto-binds via dreamedia:bind on a match.
  function pageCandidates() {
    const list = [document.title];
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content) list.push(og.content);
    const h1 = document.querySelector("h1");
    if (h1?.textContent) list.push(h1.textContent.trim());
    return list.filter(Boolean);
  }

  let anchorAttempts = 0;
  function tryAnchor() {
    if (window.__dreamediaBinding?.entryId || anchorAttempts >= 6) return;
    anchorAttempts += 1;
    send("dreamedia:anchor", { candidates: pageCandidates(), url: location.href });
  }
  // Titles settle late on some players and change on SPA navigation.
  setTimeout(tryAnchor, 3000);
  setInterval(tryAnchor, 10000);

  // Receive the popup's binding for this tab.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "dreamedia:bind") {
      window.__dreamediaBinding = msg.binding;
      console.debug("[DreaMedia] bound to entry", msg.binding);
    }
  });
  // Restore a binding for this tab (survives reloads within the session).
  // MV2 (Firefox) has no storage.session — fall back to storage.local.
  const store = chrome.storage.session || chrome.storage.local;
  store.get("dreamediaBinding").then((r) => {
    if (r?.dreamediaBinding) window.__dreamediaBinding = r.dreamediaBinding;
  }).catch(() => {});

  window.DreaMediaCore.start({
    onInterval: (video) => {
      const p = payload(video);
      if (p) send("dreamedia:progress", { payload: p });
    },
    onPause: (video) => {
      const p = payload(video);
      if (p) send("dreamedia:liveEnd", { payload: p });
    },
    // Episode advances when a video ends (site-agnostic approximation).
    onEnded: (video) => {
      const binding = window.__dreamediaBinding;
      if (!binding) return;
      const p = payload(video); // final position of the finished episode
      binding.episode = (binding.episode || 0) + 1;
      (chrome.storage.session || chrome.storage.local).set({ dreamediaBinding: binding });
      if (p) send("dreamedia:liveEnd", { payload: p });
    },
  }, LIVE_INTERVAL_MS);
})();
