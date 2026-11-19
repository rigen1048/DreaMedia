/* DreaMedia content script (D55) — site-agnostic watch tracking.
 * Video-attach model from SyncNwatch: first ready <video>, robust selector
 * cached per host, MutationObserver + URL-change re-attach. Reports the
 * timestamp to the backend every 15s and on pause/ended. */
(() => {
  const REPORT_INTERVAL_MS = 15000;

  function generateSelector(video) {
    if (video.id) return `#${CSS.escape(video.id)}`;
    if (video.classList.length > 0) return `video.${Array.from(video.classList).join(".")}`;
    const path = [];
    let el = video;
    while (el && el !== document.body) {
      let selector = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
        if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(el) + 1})`;
      }
      path.unshift(selector);
      el = parent;
    }
    return path.join(" > ");
  }

  function findVideo() {
    const host = location.hostname;
    const saved = sessionStorage.getItem(`dreamedia_${host}`);
    if (saved) {
      const v = document.querySelector(saved);
      if (v && !v.dataset.dreamedia && v.readyState > 0) return v;
      sessionStorage.removeItem(`dreamedia_${host}`);
    }
    for (const v of document.getElementsByTagName("video")) {
      if (!v.dataset.dreamedia && v.readyState > 0) return v;
    }
    return null;
  }

  function attach(video) {
    video.dataset.dreamedia = "true";
    sessionStorage.setItem(`dreamedia_${location.hostname}`, generateSelector(video));

    const report = (reason) => {
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
    };

    // Episode advances when a video ends (site-agnostic approximation).
    video.addEventListener("ended", () => {
      const binding = window.__dreamediaBinding;
      if (binding) {
        binding.episode = (binding.episode || 0) + 1;
        (chrome.storage.session || chrome.storage.local).set({ dreamediaBinding: binding });
        report("ended");
      }
    });
    video.addEventListener("pause", () => report("pause"));
    setInterval(() => {
      if (!video.paused) report("interval");
    }, REPORT_INTERVAL_MS);
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

  const observer = new MutationObserver(() => {
    const v = findVideo();
    if (v) attach(v);
  });
  observer.observe(document, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      sessionStorage.removeItem(`dreamedia_${location.hostname}`);
      const v = findVideo();
      if (v) attach(v);
    }
  }, 1000);

  const v = findVideo();
  if (v) attach(v);
})();
