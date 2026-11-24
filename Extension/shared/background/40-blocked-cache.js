
// ---- blocked list (phase 4): server copy -> local cache ----

const Q_BLOCKED = `query Blocked { blockedList { name url reason } }`;

async function cachedBlocked() {
  return (await chrome.storage.local.get("blockedYt")).blockedYt || [];
}

async function fetchBlocked() {
  try {
    const data = await gqlWs(Q_BLOCKED, {});
    await chrome.storage.local.set({ blockedYt: data.blockedList || [] });
  } catch (_e) {
    // vault locked / backend offline: keep the cached copy (stale beats none)
  }
  return cachedBlocked();
}
