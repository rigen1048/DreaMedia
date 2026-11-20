/* DreaMedia anime module (ext v2): watch tracking for allowlisted 'ani'
 * domains. Bound by the popup (manual override today; anchor-detection
 * auto-bind is design phase 3). Reports timestamps to the backend every
 * 15s and on pause/ended via the background lane. Requires core.js. */
(() => {
  function report(video, reason) {
    const binding = window.__dreamediaBinding;
    if (!binding || !binding.entryId) return; // popup binds this tab first
    const payload = {
      entry_id: binding.entryId,
      season: binding.season,
      episode: binding.episode,
      position_seconds: Math.floor(video.currentTime || 0),
    };
    chrome.runtime.sendMessage({ type: "dreamedia:progress", payload }, () => void chrome.runtime.lastError);
    console.debug("[DreaMedia] progress", reason, payload);
  }

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
    onInterval: (video) => report(video, "interval"),
    onPause: (video) => report(video, "pause"),
    // Episode advances when a video ends (site-agnostic approximation).
    onEnded: (video) => {
      const binding = window.__dreamediaBinding;
      if (binding) {
        binding.episode = (binding.episode || 0) + 1;
        (chrome.storage.session || chrome.storage.local).set({ dreamediaBinding: binding });
        report(video, "ended");
      }
    },
  });
})();
