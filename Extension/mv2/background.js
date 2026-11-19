/* DreaMedia background (D55): the ONLY network lane for the extension.
 * Content/popup scripts never fetch directly — they message here, and this
 * worker/page calls the backend with the stored token. */
const DEFAULT_BACKEND = "http://127.0.0.1:8000";

async function backend() {
  const r = await chrome.storage.local.get(["backendUrl", "token"]);
  return { url: (r.backendUrl || DEFAULT_BACKEND).replace(/\/$/, ""), token: r.token || "" };
}

async function call(path, options = {}) {
  const { url, token } = await backend();
  const resp = await fetch(`${url}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-DreaMedia-Token": token,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "dreamedia:ping":
          sendResponse({ ok: true, data: await call("/ext/ping") });
          break;
        case "dreamedia:subscribe":
          sendResponse({ ok: true, data: await call("/ext/subscribe", { method: "POST", body: msg.body }) });
          break;
        case "dreamedia:cards":
          sendResponse({ ok: true, data: await call("/ext/cards") });
          break;
        case "dreamedia:addItem":
          sendResponse({ ok: true, data: await call(`/ext/cards/${msg.cardId}/items`, { method: "POST", body: { links: msg.links } }) });
          break;
        case "dreamedia:aniEntries":
          sendResponse({ ok: true, data: await call("/ext/ani/entries") });
          break;
        case "dreamedia:progress":
          sendResponse({ ok: true, data: await call("/ext/progress", { method: "POST", body: msg.payload }) });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true; // async response
});
