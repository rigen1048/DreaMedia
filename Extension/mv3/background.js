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
  const value = String(raw || "").trim();
  if (!value) return "";
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let d;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    d = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch (_e) {
    return "";
  }
  return d.startsWith("www.") ? d.slice(4) : d;
}

function domainHostPatterns(raw) {
  const host = normalizeDomain(raw);
  if (!host) return [];
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
  const matchHost = isIp || host === "localhost" ? host : `*.${host}`;
  return [`http://${matchHost}/*`, `https://${matchHost}/*`];
}

function exactOriginPattern(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    return [`${url.protocol}//${url.hostname}/*`];
  } catch (_e) {
    return [];
  }
}

async function originGranted(origins) {
  if (!origins.length || !chrome.permissions?.contains) return false;
  try { return await chrome.permissions.contains({ origins }); } catch (_e) { return false; }
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

async function pruneUnusedHostPermissions(domains) {
  if (!chrome.permissions?.getAll || !chrome.permissions?.remove) return;
  const required = new Set();
  const { url: activeBackend } = await backend();
  for (const origin of exactOriginPattern(activeBackend)) required.add(origin);
  for (const domain of domains) {
    if (!domain.domain || !domain.enabled) continue;
    for (const origin of domainHostPatterns(domain.domain)) required.add(origin);
  }
  const granted = await chrome.permissions.getAll();
  const stale = (granted.origins || []).filter(
    (origin) => /^(https?):\/\//i.test(origin) && !required.has(origin),
  );
  if (stale.length) await chrome.permissions.remove({ origins: stale });
}

// MV2 (Firefox) registration handles live in memory (persistent background).
const mv2Handles = new Map();

async function registerDomains(domains) {
  const wanted = [];
  for (const d of domains) {
    if (!d.domain || !d.enabled) continue;
    const js = MEDIA_JS[d.media];
    if (!js) continue;
    const matches = domainHostPatterns(d.domain);
    if (!matches.length || !(await originGranted(matches))) continue;
    wanted.push({
      id: `${d.media}-${d.domain}`,
      matches,
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
    const domains = await fetchDomains();
    await registerDomains(domains);
    await pruneUnusedHostPermissions(domains);
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

// ---- live lane (ext v2 phase 2): graphql-transport-ws, HTTP fallback ----
// One socket carries watch progress and owns the extension connection state.
// Green requires a token-authenticated extPing after the protocol ack. The
// periodic transport ping keeps an idle MV3 service worker with a socket alive.

const M_PROGRESS = `mutation LiveProgress($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!, $eventTimeMs: String) {
  liveProgress(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds, eventTimeMs: $eventTimeMs)
}`;
const M_END = `mutation LiveEnd($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!, $eventTimeMs: String) {
  liveEnd(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds, eventTimeMs: $eventTimeMs)
}`;
const Q_WS_AUTH_PROBE = "query { extPing }";
const WS_HANDSHAKE_TIMEOUT_MS = 15000;

let ws = null;
let wsReady = false;
let wsRetry = null;
let wsKeepalive = null;
let wsHandshakeTimer = null;
let wsAuthProbeId = null;
let wsConnectPromise = null;
let wsGeneration = 0;
let gqlSeq = 0;
const pendingOps = new Map();

function extensionAction() {
  return chrome.action || chrome.browserAction;
}

const CONNECTION_FAILURE_GRACE_MS = 30000;
const WS_KEEPALIVE_INTERVAL_MS = 20000;
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
    // Keep a previously authenticated connection green while it reconnects.
    // A new handshake remains yellow until the token probe succeeds.
    if (connectionState.status === "disconnected") return;
    if (connectionState.status === "connected") {
      if (!connectionFailureTimer) {
        pendingConnectionFailureReason = "WebSocket reconnect timed out";
        connectionFailureTimer = setTimeout(() => {
          connectionFailureTimer = null;
          void commitConnectionState("disconnected", pendingConnectionFailureReason);
        }, CONNECTION_FAILURE_GRACE_MS);
      }
      return;
    }
    await commitConnectionState("connecting");
    if (!connectionFailureTimer) {
      pendingConnectionFailureReason = "WebSocket handshake timed out";
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

function clearWsHandshakeTimer() {
  if (wsHandshakeTimer) {
    clearTimeout(wsHandshakeTimer);
    wsHandshakeTimer = null;
  }
}

function startWsKeepalive(socket) {
  stopWsKeepalive();
  wsKeepalive = setInterval(() => {
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      // graphql-transport-ws ping traffic also keeps an MV3 service worker alive.
      socket.send(JSON.stringify({ type: "ping" }));
    } catch (error) {
      if (ws === socket) wsDead(error.message || "WebSocket keepalive failed");
    }
  }, WS_KEEPALIVE_INTERVAL_MS);
}

function wsDead(reason = "Connection closed") {
  wsReady = false;
  ws = null;
  wsAuthProbeId = null;
  clearWsHandshakeTimer();
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
  if (wsConnectPromise) return wsConnectPromise;
  const attempt = connectWs();
  wsConnectPromise = attempt;
  try {
    await attempt;
  } catch (error) {
    await publishConnectionState("disconnected", error.message || "WebSocket setup failed");
    scheduleWsRetry();
  } finally {
    if (wsConnectPromise === attempt) wsConnectPromise = null;
  }
}

async function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const generation = wsGeneration;
  wsReady = false;
  wsAuthProbeId = null;
  if (ws) {
    try { ws.close(); } catch (_e) { /* stale socket */ }
    ws = null;
  }
  const { url, token } = await backend();
  if (generation !== wsGeneration) {
    scheduleWsRetry();
    return;
  }
  if (!token) {
    await publishConnectionState("idle", "Not configured");
    return;
  }
  await publishConnectionState("connecting");
  if (generation !== wsGeneration) {
    scheduleWsRetry();
    return;
  }
  try {
    ws = new WebSocket(`${url.replace(/^http/, "ws")}/ext/graphql`, "graphql-transport-ws");
  } catch (error) {
    ws = null;
    await publishConnectionState("disconnected", error.message || "WebSocket unavailable");
    scheduleWsRetry();
    return;
  }
  const socket = ws;
  wsHandshakeTimer = setTimeout(() => {
    wsHandshakeTimer = null;
    if (ws !== socket || wsReady) return;
    const reason = "WebSocket acknowledgement/authentication probe timed out";
    try {
      if (socket.readyState < WebSocket.CLOSING) socket.close(4000, "DreaMedia handshake timeout");
    } catch (_e) { /* force local cleanup below */ }
    if (ws === socket) wsDead(reason);
  }, WS_HANDSHAKE_TIMEOUT_MS);
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
      if (ws !== socket || wsReady || wsAuthProbeId) return;
      startWsKeepalive(socket);
      wsAuthProbeId = `auth-${++gqlSeq}`;
      try {
        socket.send(JSON.stringify({
          id: wsAuthProbeId,
          type: "subscribe",
          payload: { query: Q_WS_AUTH_PROBE, variables: {} },
        }));
      } catch (error) {
        wsDead(error.message || "WebSocket authentication probe failed");
      }
    } else if (msg.type === "ping") {
      try {
        const pong = { type: "pong" };
        if (Object.prototype.hasOwnProperty.call(msg, "payload")) pong.payload = msg.payload;
        socket.send(JSON.stringify(pong));
      } catch (_e) { /* close handler retries */ }
    } else if (msg.type === "next" || msg.type === "complete" || msg.type === "error") {
      if (msg.id === wsAuthProbeId) {
        if (msg.type !== "next" || msg.payload?.data?.extPing !== true || msg.payload?.errors?.length) {
          const detail = msg.payload?.errors?.[0]?.message;
          try {
            if (socket.readyState < WebSocket.CLOSING) socket.close(4401, "Authentication probe failed");
          } catch (_e) { /* force local cleanup below */ }
          wsDead(detail || "WebSocket authentication probe failed");
          return;
        }
        wsAuthProbeId = null;
        wsReady = true;
        clearWsHandshakeTimer();
        if (wsRetry) {
          clearTimeout(wsRetry);
          wsRetry = null;
        }
        void publishConnectionState("connected");
        return;
      }
      const resolve = pendingOps.get(msg.id);
      if (resolve) {
        pendingOps.delete(msg.id);
        const hasExecutionErrors = msg.type === "next" && msg.payload?.errors?.length > 0;
        resolve(msg.type !== "error" && !hasExecutionErrors);
      }
    }
  };
  socket.onclose = (event) => {
    if (ws !== socket) return;
    const closeDetails = [`WebSocket closed (${event?.code || "unknown"})`];
    if (event?.reason) closeDetails.push(event.reason);
    wsDead(closeDetails.join(": "));
  };
  socket.onerror = () => {
    if (ws !== socket) return;
    // Let the close event perform one cleanup/retry and retain its close code.
    try { socket.close(); } catch (_e) { wsDead("WebSocket transport error"); }
  };
}

async function liveGql(query, p) {
  const variables = {
    entryId: p.entry_id, season: p.season, episode: p.episode, positionSeconds: p.position_seconds,
    eventTimeMs: p.event_time_ms == null ? null : String(p.event_time_ms),
  };
  await ensureWs();
  if (wsReady && ws?.readyState === WebSocket.OPEN) {
    return new Promise((resolve) => {
      const id = String(++gqlSeq);
      pendingOps.set(id, resolve);
      try {
        ws.send(JSON.stringify({ id, type: "subscribe", payload: { query, variables } }));
      } catch (error) {
        pendingOps.delete(id);
        resolve(false);
        if (ws) wsDead(error.message || "WebSocket operation send failed");
        return;
      }
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

function reconnectAfterConfigurationChange() {
  const oldSocket = ws;
  wsGeneration += 1;
  wsReady = false;
  ws = null;
  wsAuthProbeId = null;
  clearWsHandshakeTimer();
  stopWsKeepalive();
  for (const resolve of pendingOps.values()) resolve(false);
  pendingOps.clear();
  try {
    if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) {
      oldSocket.close(4000, "Configuration changed");
    }
  } catch (_e) { /* the next connection attempt replaces it */ }
  if (connectionFailureTimer) clearTimeout(connectionFailureTimer);
  pendingConnectionFailureReason = "WebSocket reconfiguration timed out";
  connectionFailureTimer = setTimeout(() => {
    connectionFailureTimer = null;
    void commitConnectionState("disconnected", pendingConnectionFailureReason);
  }, CONNECTION_FAILURE_GRACE_MS);
  void commitConnectionState("connecting");
  void ensureWs();
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && (changes.backendUrl || changes.token)) {
    reconnectAfterConfigurationChange();
    void refreshDomains();
  }
});
chrome.permissions?.onRemoved?.addListener(() => void refreshDomains());

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

async function scanYoutubeSubscriptions(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let url;
  try { url = new URL(tab.url || ""); } catch (_e) { throw new Error("Open YouTube's channel subscriptions page first."); }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname) || url.pathname !== "/feed/channels") {
    throw new Error("Open YouTube's channel subscriptions page (/feed/channels) first.");
  }
  if (chrome.scripting?.executeScript) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["modules/youtube-import.js"],
    });
  } else if (chrome.tabs?.executeScript) {
    await chrome.tabs.executeScript(tabId, { file: "modules/youtube-import.js" });
  } else {
    throw new Error("This browser does not support active-tab import scanning.");
  }
  const result = await chrome.tabs.sendMessage(tabId, { type: "dreamedia:scanYoutubeSubscriptions" });
  if (!result?.ok) throw new Error(result?.error || "Could not scan the subscriptions page.");
  return result;
}

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
        case "dreamedia:scanYoutubeSubscriptions": {
          const result = await scanYoutubeSubscriptions(Number(msg.tabId));
          sendResponse({ ok: true, data: result });
          break;
        }
        case "dreamedia:importYoutubeSubscriptions": {
          const data = await gqlHttp(
            `mutation ImportYouTubeChannels($links: [String!]!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
              importYoutubeChannels(links: $links, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { added skipped requested errors }
            }`,
            {
              links: msg.links,
              kind: msg.kind,
              words: msg.words ?? null,
              rank: msg.rank ?? null,
              withhold: msg.withhold ?? null,
              domain: msg.domain ?? null,
              subdomain: msg.subdomain ?? null,
            },
          );
          sendResponse({ ok: true, data: data.importYoutubeChannels });
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
          const permissionGranted = hit
            ? await originGranted(domainHostPatterns(hit.domain))
            : false;
          sendResponse({ ok: true, host, registered: hit || null, permissionGranted });
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

// Register and start background work only after connection state has been
// initialized; refreshAll invokes ensureWs synchronously up to its first await.
chrome.runtime.onStartup?.addListener(() => void refreshAll());
chrome.runtime.onInstalled?.addListener(() => void refreshAll());
chrome.alarms?.create("dreamedia:domains", { periodInMinutes: 30 });
chrome.alarms?.create("dreamedia:ws-watchdog", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamedia:domains") void refreshAll();
  if (alarm.name === "dreamedia:ws-watchdog") void ensureWs();
});
void refreshAll(); // service-worker wake / persistent background load
