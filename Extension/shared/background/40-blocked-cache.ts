interface BgBlockedEntry {
  name: string;
  url: string;
  reason?: string | null;
}

// ---- blocked list (phase 4): server copy -> local cache ----

const Q_BLOCKED = `query Blocked { blockedList { name url reason } }`;

async function cachedBlocked(): Promise<BgBlockedEntry[]> {
  const stored: unknown = (await chrome.storage.local.get("blockedYt")).blockedYt;
  return (stored as BgBlockedEntry[] | null | undefined) || [];
}

async function fetchBlocked(): Promise<BgBlockedEntry[]> {
  try {
    const data = await gqlWs<{ blockedList?: BgBlockedEntry[] | null }>(Q_BLOCKED, {});
    await chrome.storage.local.set({ blockedYt: data.blockedList || [] });
  } catch (_e) {
    // vault locked / backend offline: keep the cached copy (stale beats none)
  }
  return cachedBlocked();
}
