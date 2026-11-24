/* One-shot, user-triggered scan for YouTube's channel subscriptions page.
 * The script reads rendered channel anchors locally and returns them to the
 * extension popup only; it never sends data to DreaMedia by itself. */
(() => {
  interface Channel {
    url: string;
    name: string;
  }

  type ScanResult =
    | { ok: false; error: string }
    | { ok: true; channels: Channel[]; complete: boolean; rounds: number };

  const CHANNEL_PATH = /^\/(?:@[^/]+|channel\/UC[A-Za-z0-9_-]{22})(?:\/|$)/i;
  const CHANNEL_HOSTS = new Set(["youtube.com", "www.youtube.com"]);
  const SELECTORS = "ytd-channel-renderer, ytd-grid-channel-renderer";
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(anchor: HTMLAnchorElement): boolean {
    const style = getComputedStyle(anchor);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function channelFromAnchor(anchor: HTMLAnchorElement): Channel | null {
    if (!visible(anchor)) return null;
    let url: URL;
    try { url = new URL(anchor.getAttribute("href") || "", location.href); } catch (_e) { return null; }
    if (!CHANNEL_HOSTS.has(url.hostname.toLowerCase()) || !CHANNEL_PATH.test(url.pathname)) return null;
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

  function collect(found: Map<string, Channel>): void {
    for (const row of Array.from(document.querySelectorAll(SELECTORS))) {
      for (const anchor of Array.from(row.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
        const channel = channelFromAnchor(anchor);
        if (channel && !found.has(channel.url.toLowerCase())) {
          found.set(channel.url.toLowerCase(), channel);
        }
      }
    }
  }

  async function scan(): Promise<ScanResult> {
    if (!CHANNEL_HOSTS.has(location.hostname.toLowerCase()) || location.pathname !== "/feed/channels") {
      return { ok: false, error: "Open YouTube's channel subscriptions page (/feed/channels) first." };
    }
    const scroller = document.scrollingElement || document.documentElement;
    const originalTop = scroller.scrollTop;
    const found = new Map<string, Channel>();
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

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return undefined;
    if (message.type !== "dreamedia:scanYoutubeSubscriptions") return undefined;
    scan().then(
      (result) => sendResponse(result),
      (error: unknown) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message || "Scan failed." : "Scan failed.",
      })
    );
    return true;
  });
})();
