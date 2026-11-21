/* One-shot, user-triggered scan for YouTube's channel subscriptions page.
 * The script reads rendered channel anchors locally and returns them to the
 * extension popup only; it never sends data to DreaMedia by itself. */
(() => {
  if (window.__dreamediaSubscriptionImportInstalled) return;
  window.__dreamediaSubscriptionImportInstalled = true;

  const CHANNEL_PATH = /^\/(?:@[^/]+|channel\/UC[A-Za-z0-9_-]{22})(?:\/|$)/i;
  const SELECTORS = "ytd-channel-renderer, ytd-grid-channel-renderer, ytd-guide-entry-renderer";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(anchor) {
    const style = getComputedStyle(anchor);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function channelFromAnchor(anchor) {
    if (!visible(anchor)) return null;
    let url;
    try { url = new URL(anchor.getAttribute("href") || "", location.href); } catch (_e) { return null; }
    if (!/(^|\.)youtube\.com$/i.test(url.hostname) || !CHANNEL_PATH.test(url.pathname)) return null;
    const path = url.pathname.replace(/\/+$/, "") || url.pathname;
    const canonicalUrl = `https://www.youtube.com${path}`;
    const row = anchor.closest(SELECTORS);
    const label = row?.querySelector("#channel-title, #channel-name a, yt-formatted-string#text");
    const name = (
      anchor.getAttribute("title") || anchor.getAttribute("aria-label") ||
      label?.textContent || anchor.textContent || ""
    ).replace(/\s+/g, " ").trim();
    return { url: canonicalUrl, name: name || path.slice(1) };
  }

  function collect(found) {
    for (const row of document.querySelectorAll(SELECTORS)) {
      for (const anchor of row.querySelectorAll("a[href]")) {
        const channel = channelFromAnchor(anchor);
        if (channel && !found.has(channel.url.toLowerCase())) {
          found.set(channel.url.toLowerCase(), channel);
        }
      }
    }
  }

  async function scan() {
    if (!/(^|\.)youtube\.com$/i.test(location.hostname) || location.pathname !== "/feed/channels") {
      return { ok: false, error: "Open YouTube's channel subscriptions page (/feed/channels) first." };
    }
    const scroller = document.scrollingElement || document.documentElement;
    const originalTop = scroller.scrollTop;
    const found = new Map();
    let previousCount = -1;
    let previousHeight = -1;
    let stableRounds = 0;
    let rounds = 0;
    const maxRounds = 100;
    try {
      for (; rounds < maxRounds; rounds += 1) {
        collect(found);
        const height = scroller.scrollHeight;
        const count = found.size;
        if (height === previousHeight && count === previousCount) stableRounds += 1;
        else stableRounds = 0;
        if (stableRounds >= 3) break;
        previousHeight = height;
        previousCount = count;
        scroller.scrollTop = height;
        window.scrollTo(0, height);
        await sleep(800);
      }
      collect(found);
    } finally {
      scroller.scrollTop = originalTop;
      window.scrollTo(0, originalTop);
    }
    return {
      ok: true,
      channels: [...found.values()],
      complete: stableRounds >= 3,
      rounds: Math.min(rounds + 1, maxRounds),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "dreamedia:scanYoutubeSubscriptions") return undefined;
    scan().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || "Scan failed." }));
    return true;
  });
})();
