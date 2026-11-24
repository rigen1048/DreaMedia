/* DreaMedia youtube module (ext v2 phase 4): page-side behavior for
 * allowlisted 'yt' domains. Subscribe-from-page and playlist add are
 * popup-driven; this module owns the blocked-channel disclaimer — matched
 * LOCALLY against the cached blocked list, nothing per-page goes out. */
(() => {
  interface BlockedChannel {
    url: string;
    name: string;
    reason: string | null;
  }

  interface YoutubeCoreApi {
    showBlocked(title: string, reason: string | null): void;
  }

  interface YoutubeWindow extends Window {
    DreaMediaCore: YoutubeCoreApi;
  }

  const youtubeWindow = window as unknown as YoutubeWindow;
  let blocked: BlockedChannel[] = [];

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function loadBlocked(): void {
    chrome.runtime.sendMessage({ type: "dreamedia:blockedYT" }, (resp: unknown) => {
      if (isRecord(resp) && resp.ok && Array.isArray(resp.data)) {
        blocked = resp.data as BlockedChannel[];
      }
      void chrome.runtime.lastError;
    });
  }

  // youtube.com/@handle, /channel/UC…, /c/name, /user/name → comparable key
  function channelKey(rawUrl: string): string | null {
    try {
      const u = new URL(rawUrl, "https://www.youtube.com");
      const m = u.pathname.match(/^\/(\@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/i);
      const key = m?.[1];
      return key ? key.toLowerCase() : null;
    } catch (_e) {
      return null;
    }
  }

  let lastUrl = "";
  function check(): void {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const here = channelKey(location.href);
    if (!here) return;
    const hit = blocked.find((b) => channelKey(b.url) === here);
    if (hit) youtubeWindow.DreaMediaCore.showBlocked(hit.name, hit.reason);
  }

  loadBlocked();
  setInterval(loadBlocked, 10 * 60 * 1000); // refresh the local cache copy
  setInterval(check, 1000); // SPA navigation
  check();
})();
