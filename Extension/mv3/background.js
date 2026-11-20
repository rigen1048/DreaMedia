/* DreaMedia background (D55, ext v2): the ONLY network lane for the
 * extension — content/popup scripts never fetch directly. It also owns
 * dynamic content-script registration: modules load ONLY on domains from
 * the user's allowlist (ext_domains), never on arbitrary pages. */
const DEFAULT_BACKEND = "http://127.0.0.1:8000";
const MEDIA_JS = {
  ani: ["core.js", "modules/anime.js"],
  yt: ["core.js", "modules/youtube.js"],
};

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

function normalizeDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").split(/[/?#]/)[0].split(":")[0];
  return d.startsWith("www.") ? d.slice(4) : d;
}

// ---- domain allowlist: fetch, cache, register ----

async function cachedDomains() {
  return (await chrome.storage.local.get("domains")).domains || [];
}

async function fetchDomains() {
  try {
    const data = await call("/ext/domains");
    await chrome.storage.local.set({ domains: data.domains || [] });
  } catch (_e) {
    // 423 (vault locked), 401 (no token yet) or backend offline: keep the
    // last cached copy — registration keeps working, possibly stale.
  }
  return cachedDomains();
}

// MV2 (Firefox) registration handles live in memory (persistent background).
const mv2Handles = new Map();

async function registerDomains(domains) {
  const wanted = [];
  for (const d of domains) {
    if (!d.domain || !d.enabled) continue;
    const js = MEDIA_JS[d.media];
    if (!js) continue;
    wanted.push({
      id: `${d.media}-${d.domain}`,
      // Chrome match patterns: *.example.com also matches example.com itself.
      matches: [`*://*.${d.domain}/*`],
      js,
    });
  }

  if (chrome.scripting?.registerContentScripts) {
    // MV3: registrations persist across service-worker restarts, so rebuild
    // the full set each time.
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
    if (wanted.length) {
      await chrome.scripting.registerContentScripts(
        wanted.map((w) => ({ id: w.id, matches: w.matches, js: w.js, runAt: "document_idle" })),
      );
    }
    return;
  }

  // MV2 Firefox: contentScripts.register (host permission covers matches).
  const api = (typeof browser !== "undefined" ? browser : chrome).contentScripts;
  if (!api?.register) return;
  for (const handle of mv2Handles.values()) handle.unregister();
  mv2Handles.clear();
  for (const w of wanted) {
    mv2Handles.set(
      w.id,
      await api.register({ matches: w.matches, js: w.js.map((file) => ({ file })), runAt: "document_idle" }),
    );
  }
}

async function refreshDomains() {
  try {
    await registerDomains(await fetchDomains());
  } catch (e) {
    console.debug("[DreaMedia] domain refresh failed", e);
  }
}

chrome.runtime.onStartup?.addListener(() => void refreshDomains());
chrome.runtime.onInstalled?.addListener(() => void refreshDomains());
void refreshDomains(); // service-worker wake / persistent background load

chrome.alarms?.create("dreamedia:domains", { periodInMinutes: 30 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamedia:domains") void refreshDomains();
});

// ---- live lane (ext v2 phase 2): graphql-transport-ws, HTTP fallback ----
// One socket carries watch progress; while it streams, MV3 keeps the
// service worker alive. If the socket is down we POST to /ext/graphql.

const M_PROGRESS = `mutation LiveProgress($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!) {
  liveProgress(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds)
}`;
const M_END = `mutation LiveEnd($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!) {
  liveEnd(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds)
}`;

let ws = null;
let wsReady = false;
let wsRetry = null;
let gqlSeq = 0;
const pendingOps = new Map();

function wsDead() {
  wsReady = false;
  ws = null;
  for (const resolve of pendingOps.values()) resolve(false);
  pendingOps.clear();
  if (!wsRetry) {
    wsRetry = setTimeout(() => {
      wsRetry = null;
      void ensureWs();
    }, 5000);
  }
}

async function ensureWs() {
  if (ws) return;
  const { url, token } = await backend();
  if (!token) return;
  try {
    ws = new WebSocket(`${url.replace(/^http/, "ws")}/ext/graphql`, "graphql-transport-ws");
  } catch (_e) {
    ws = null;
    return;
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init", payload: { token } }));
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_e) {
      return;
    }
    if (msg.type === "connection_ack") {
      wsReady = true;
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    } else if (msg.type === "next" || msg.type === "complete" || msg.type === "error") {
      const resolve = pendingOps.get(msg.id);
      if (resolve) {
        pendingOps.delete(msg.id);
        resolve(msg.type !== "error");
      }
    }
  };
  ws.onclose = wsDead;
  ws.onerror = () => ws.close();
}

async function liveGql(query, p) {
  const variables = {
    entryId: p.entry_id, season: p.season, episode: p.episode, positionSeconds: p.position_seconds,
  };
  await ensureWs();
  if (wsReady) {
    return new Promise((resolve) => {
      const id = String(++gqlSeq);
      pendingOps.set(id, resolve);
      ws.send(JSON.stringify({ id, type: "subscribe", payload: { query, variables } }));
      setTimeout(() => {
        const pending = pendingOps.get(id);
        if (pending) {
          pendingOps.delete(id);
          pending(false);
        }
      }, 10000);
    });
  }
  const { url, token } = await backend();
  try {
    const resp = await fetch(`${url}/ext/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DreaMedia-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    return resp.ok;
  } catch (_e) {
    return false;
  }
}

// ---- message lane ----

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
          sendResponse({ ok: true, data: await liveGql(M_PROGRESS, msg.payload) });
          break;
        case "dreamedia:liveEnd":
          sendResponse({ ok: true, data: await liveGql(M_END, msg.payload) });
          break;
        case "dreamedia:domainStatus": {
          const host = normalizeDomain(msg.url);
          const hit = (await cachedDomains()).find(
            (d) => host === d.domain || host.endsWith(`.${d.domain}`),
          );
          sendResponse({ ok: true, host, registered: hit || null });
          break;
        }
        case "dreamedia:addDomain": {
          const data = await call("/ext/domains", {
            method: "POST",
            body: { domain: msg.domain, media: msg.media },
          });
          await refreshDomains();
          sendResponse({ ok: true, data });
          break;
        }
        case "dreamedia:refreshDomains":
          await refreshDomains();
          sendResponse({ ok: true });
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
