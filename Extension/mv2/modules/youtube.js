/* DreaMedia youtube module (ext v2 phase 4): page-side behavior for
 * allowlisted 'yt' domains. Subscribe-from-page and playlist add are
 * popup-driven; this module owns the blocked-channel disclaimer — matched
 * LOCALLY against the cached blocked list, nothing per-page goes out. */
(() => {
  let blocked = [];

  function loadBlocked() {
    chrome.runtime.sendMessage({ type: "dreamedia:blockedYT" }, (resp) => {
      if (resp?.ok && Array.isArray(resp.data)) blocked = resp.data;
      void chrome.runtime.lastError;
    });
  }

  // youtube.com/@handle, /channel/UC…, /c/name, /user/name → comparable key
  function channelKey(rawUrl) {
    try {
      const u = new URL(rawUrl, "https://www.youtube.com");
      const m = u.pathname.match(/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/i);
      return m ? m[1].toLowerCase() : null;
    } catch (_e) {
      return null;
    }
  }

  let lastUrl = "";
  function check() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const here = channelKey(location.href);
    if (!here) return;
    const hit = blocked.find((b) => channelKey(b.url) === here);
    if (hit) window.DreaMediaCore.showBlocked(hit.name, hit.reason);
  }

  loadBlocked();
  setInterval(loadBlocked, 10 * 60 * 1000); // refresh the local cache copy
  setInterval(check, 1000); // SPA navigation
  check();
})();
