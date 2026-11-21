/* DreaMedia background (D55, ext v2): the ONLY network lane for the
 * extension — content/popup scripts never fetch directly. It also owns
 * dynamic content-script registration: modules load ONLY on domains from
 * the user's allowlist (ext_domains), never on arbitrary pages. */
const DEFAULT_BACKEND = "http://127.0.0.1:8123";
const MEDIA_JS = {
  ani: ["core.js", "modules/anime.js"],
  yt: ["core.js", "modules/youtube.js"],
};

async function backend() {
  const r = await chrome.storage.local.get(["backendUrl", "token"]);
  return { url: (r.backendUrl || DEFAULT_BACKEND).replace(/\/$/, ""), token: r.token || "" };
}

async function gqlHttp(query, variables) {
  const { url, token } = await backend();
  const resp = await fetch(`${url}/ext/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DreaMedia-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.errors) throw new Error(data.errors?.[0]?.message || `HTTP ${resp.status}`);
  return data.data;
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
    const data = await gqlHttp("query { domains { id domain media enabled } }", {});
    await chrome.storage.local.set({ domains: data.domains || [] });
  } catch (_e) {
    // vault locked, no token yet, or backend offline: keep the last cached
    // copy — registration keeps working, possibly stale.
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

async function refreshAll() {
  // Reassert the live lane first; HTTP refreshes must not delay the socket.
  void ensureWs();
  await refreshDomains();
  await fetchBlocked();
}

chrome.runtime.onStartup?.addListener(() => void refreshAll());
chrome.runtime.onInstalled?.addListener(() => void refreshAll());
void refreshAll(); // service-worker wake / persistent background load

chrome.alarms?.create("dreamedia:domains", { periodInMinutes: 30 });
chrome.alarms?.create("dreamedia:ws-watchdog", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamedia:domains") void refreshAll();
  if (alarm.name === "dreamedia:ws-watchdog") void ensureWs();
});

// ---- live lane (ext v2 phase 2): graphql-transport-ws, HTTP fallback ----
// One socket carries watch progress and owns the extension connection state.
// The popup is only a view of this background-owned connection. The periodic
// GraphQL ping also keeps an MV3 service worker with an active socket alive.

const M_PROGRESS = `mutation LiveProgress($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!) {
  liveProgress(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds)
}`;
const M_END = `mutation LiveEnd($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!) {
  liveEnd(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds)
}`;

let ws = null;
let wsReady = false;
let wsRetry = null;
let wsKeepalive = null;
let gqlSeq = 0;
const pendingOps = new Map();

function extensionAction() {
  return chrome.action || chrome.browserAction;
}

const CONNECTION_FAILURE_GRACE_MS = 2500;
let connectionFailureTimer = null;
let pendingConnectionFailureReason = "";
let connectionState = { status: "idle", reason: "Not configured" };

async function commitConnectionState(status, reason = "") {
  connectionState = { status, reason };
  const action = extensionAction();
  const indicator = {
    idle: { text: "", title: "DreaMedia: not connected" },
    connected: { text: "●", color: "#22c55e", title: "DreaMedia: connected" },
    connecting: { text: "●", color: "#eab308", title: "DreaMedia: connecting…" },
    disconnected: {
      text: "●",
      color: "#ef4444",
      title: reason ? `DreaMedia: disconnected — ${reason}` : "DreaMedia: disconnected",
    },
  }[status];
  try {
    await action?.setBadgeText?.({ text: indicator?.text || "" });
    if (indicator) {
      if (indicator.color) await action?.setBadgeBackgroundColor?.({ color: indicator.color });
      await action?.setTitle?.({ title: indicator.title });
    }
  } catch (_e) {
    // Older Firefox builds may not implement every action API.
  }
  try {
    await chrome.runtime.sendMessage({ type: "dreamedia:connectionStatus", ...connectionState });
  } catch (_e) {
    // The popup is normally the only receiver and may be closed.
  }
}

async function publishConnectionState(status, reason = "") {
  if (status === "disconnected") {
    pendingConnectionFailureReason = reason;
    if (!connectionFailureTimer) {
      connectionFailureTimer = setTimeout(() => {
        connectionFailureTimer = null;
        void commitConnectionState("disconnected", pendingConnectionFailureReason);
      }, CONNECTION_FAILURE_GRACE_MS);
    }
    return;
  }
  if (status === "connecting") {
    // Keep an established failure visible during retries; don't flash yellow
    // and red for every short-lived socket attempt.
    if (connectionState.status === "disconnected") return;
    await commitConnectionState("connecting");
    if (!connectionFailureTimer) {
      pendingConnectionFailureReason = "Connection timed out";
      connectionFailureTimer = setTimeout(() => {
        connectionFailureTimer = null;
        void commitConnectionState("disconnected", pendingConnectionFailureReason);
      }, CONNECTION_FAILURE_GRACE_MS);
    }
    return;
  }
  if (connectionFailureTimer) {
    clearTimeout(connectionFailureTimer);
    connectionFailureTimer = null;
  }
  pendingConnectionFailureReason = "";
  await commitConnectionState(status, reason);
}

function stopWsKeepalive() {
  if (wsKeepalive) {
    clearInterval(wsKeepalive);
    wsKeepalive = null;
  }
}

function startWsKeepalive() {
  stopWsKeepalive();
  wsKeepalive = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 20000);
}

function wsDead(reason = "Connection closed") {
  wsReady = false;
  ws = null;
  stopWsKeepalive();
  void publishConnectionState("disconnected", reason);
  for (const resolve of pendingOps.values()) resolve(false);
  pendingOps.clear();
  scheduleWsRetry();
}

function scheduleWsRetry() {
  if (wsRetry) return;
  wsRetry = setTimeout(() => {
    wsRetry = null;
    void ensureWs();
  }, 1000);
}

async function ensureWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (ws) {
    try { ws.close(); } catch (_e) { /* stale socket */ }
    ws = null;
  }
  const { url, token } = await backend();
  if (!token) {
    await publishConnectionState("idle", "Not configured");
    return;
  }
  await publishConnectionState("connecting");
  try {
    ws = new WebSocket(`${url.replace(/^http/, "ws")}/ext/graphql`, "graphql-transport-ws");
  } catch (error) {
    ws = null;
    await publishConnectionState("disconnected", error.message || "WebSocket unavailable");
    scheduleWsRetry();
    return;
  }
  const socket = ws;
  socket.onopen = () => {
    try {
      socket.send(JSON.stringify({ type: "connection_init", payload: { token } }));
    } catch (error) {
      if (ws === socket) wsDead(error.message || "WebSocket initialization failed");
    }
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_e) {
      return;
    }
    if (msg.type === "connection_ack") {
      if (ws !== socket) return;
      wsReady = true;
      startWsKeepalive();
      void publishConnectionState("connected");
    } else if (msg.type === "ping") {
      try { socket.send(JSON.stringify({ type: "pong" })); } catch (_e) { /* close handler retries */ }
    } else if (msg.type === "next" || msg.type === "complete" || msg.type === "error") {
      const resolve = pendingOps.get(msg.id);
      if (resolve) {
        pendingOps.delete(msg.id);
        resolve(msg.type !== "error");
      }
    }
  };
  socket.onclose = () => {
    if (ws === socket) wsDead();
  };
  socket.onerror = () => {
    if (ws !== socket) return;
    void publishConnectionState("disconnected", "WebSocket error");
    wsDead("WebSocket error");
    try { socket.close(); } catch (_e) { /* already closed */ }
  };
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
  try {
    await gqlHttp(query, variables);
    return true;
  } catch (_e) {
    return false;
  }
}

const M_ANCHOR = `mutation Anchor($candidates: [String!]!, $pageUrl: String!) {
  anchorMatch(candidates: $candidates, pageUrl: $pageUrl) {
    entryId season episode cursorSeason cursorEpisode blocked reason
  }
}`;

async function anchorBind(tabId, candidates, pageUrl) {
  const data = await gqlHttp(M_ANCHOR, { candidates, pageUrl });
  const match = data?.anchorMatch;
  if (!match?.entryId || !tabId) return false;
  // Phase 4: a blocked entry shows the disclaimer instead of binding.
  if (match.blocked) {
    await chrome.tabs.sendMessage(tabId, {
      type: "dreamedia:blocked", title: "This anime is on your blocked list.", reason: match.reason,
    }).catch(() => {});
    return true;
  }
  const binding = {
    entryId: match.entryId,
    season: match.season || match.cursorSeason || 1,
    episode: match.episode || match.cursorEpisode || 1,
  };
  await (chrome.storage.session || chrome.storage.local).set({ dreamediaBinding: binding });
  await chrome.tabs.sendMessage(tabId, { type: "dreamedia:bind", binding }).catch(() => {});
  return true;
}

// ---- blocked list (phase 4): server copy -> local cache ----

const Q_BLOCKED = `query Blocked { blockedList { name url reason } }`;

async function cachedBlocked() {
  return (await chrome.storage.local.get("blockedYt")).blockedYt || [];
}

async function fetchBlocked() {
  try {
    const data = await gqlHttp(Q_BLOCKED, {});
    await chrome.storage.local.set({ blockedYt: data.blockedList || [] });
  } catch (_e) {
    // vault locked / backend offline: keep the cached copy (stale beats none)
  }
  return cachedBlocked();
}

// ---- message lane ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "dreamedia:ping":
          void ensureWs();
          sendResponse({ ok: true, data: await gqlHttp("query { extPing }", {}) });
          break;
        case "dreamedia:connectionStatus":
          sendResponse({ ok: true, data: connectionState });
          void ensureWs();
          break;
        case "dreamedia:subscribe": {
          const body = msg.body;
          const data = await gqlHttp(
            `mutation Subscribe($link: String!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
              subscribe(link: $link, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { ok channelId }
            }`,
            {
              link: body.link,
              kind: body.kind,
              words: body.words ?? null,
              rank: body.rank ?? null,
              withhold: body.withhold ?? null,
              domain: body.domain ?? null,
              subdomain: body.subdomain ?? null,
            },
          );
          sendResponse({ ok: true, data: { ok: data.subscribe.ok } });
          break;
        }
        case "dreamedia:cards":
          sendResponse({ ok: true, data: { cards: (await gqlHttp("query { cards { id name done total } }", {})).cards } });
          break;
        case "dreamedia:addItem":
          sendResponse({
            ok: true,
            data: (await gqlHttp(
              `mutation AddItems($cardId: Int!, $links: [String!]!) {
                addCardItems(cardId: $cardId, links: $links) { added requested errors }
              }`,
              { cardId: Number(msg.cardId), links: msg.links },
            )).addCardItems,
          });
          break;
        case "dreamedia:aniEntries":
          sendResponse({
            ok: true,
            data: {
              entries: (await gqlHttp(
                "query { aniEntries { id title seasons cursorSeason cursorEpisode } }", {},
              )).aniEntries,
            },
          });
          break;
        case "dreamedia:categories":
          sendResponse({
            ok: true,
            data: {
              categories: (await gqlHttp(
                "query { ytCategories { id name subdomains { id name } } }", {},
              )).ytCategories,
            },
          });
          break;
        case "dreamedia:progress":
          sendResponse({ ok: true, data: await liveGql(M_PROGRESS, msg.payload) });
          break;
        case "dreamedia:liveEnd":
          sendResponse({ ok: true, data: await liveGql(M_END, msg.payload) });
          break;
        case "dreamedia:anchor":
          sendResponse({ ok: true, data: await anchorBind(sender.tab?.id, msg.candidates, msg.url) });
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
          const data = await gqlHttp(
            `mutation AddDomain($domain: String!, $media: String!) {
              addDomain(domain: $domain, media: $media) { id domain media enabled }
            }`,
            { domain: msg.domain, media: msg.media },
          );
          await refreshDomains();
          sendResponse({ ok: true, data });
          break;
        }
        case "dreamedia:refreshDomains":
          await refreshAll();
          sendResponse({ ok: true });
          break;
        case "dreamedia:blockedYT":
          sendResponse({ ok: true, data: await cachedBlocked() });
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
