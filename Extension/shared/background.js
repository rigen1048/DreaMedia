/* DreaMedia background (D55, ext v2): the ONLY network lane for the
 * extension — content/popup scripts never fetch directly. It also owns
 * dynamic content-script registration: modules load ONLY on domains from
 * the user's allowlist (ext_domains), never on arbitrary pages. */
const DEFAULT_BACKEND = "http://127.0.0.1:8123";
const MEDIA_JS = {
  ani: ["core.js", "modules/anime-url.js", "modules/anime.js"],
  yt: ["core.js", "modules/youtube.js"],
};
const DEFAULT_DOMAINS = [{ id: 0, domain: "youtube.com", media: "yt", enabled: true }];
const pendingSiteDomains = new Set();
// Remove the old shared binding key: each tab now owns its own in-memory match.
void chrome.storage.local.remove("dreamediaBinding").catch(() => {});
if (chrome.storage.session?.remove) {
  void chrome.storage.session.remove("dreamediaBinding").catch(() => {});
}

async function backend() {
  const r = await chrome.storage.local.get(["backendUrl", "token"]);
  return { url: (r.backendUrl || DEFAULT_BACKEND).replace(/\/$/, ""), token: r.token || "" };
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

// ---- domain allowlist: fetch, cache, register ----

async function cachedDomains() {
  const stored = await chrome.storage.local.get("domains");
  if (Array.isArray(stored.domains)) return stored.domains;
  return DEFAULT_DOMAINS;
}

function urlMatchesDomain(url, domain) {
  const host = normalizeDomain(url);
  const allowed = normalizeDomain(domain);
  return Boolean(host && allowed && (host === allowed || host.endsWith(`.${allowed}`)));
}

function urlMatchesEnabledDomains(url, domains) {
  return domains.some((row) => row?.enabled && urlMatchesDomain(url, row.domain));
}

async function hasEnabledSiteTab() {
  const domains = (await cachedDomains()).filter((row) => row?.enabled);
  for (const domain of pendingSiteDomains) domains.push({ domain, enabled: true });
  if (!domains.length) return false;
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (_e) {
    return false;
  }
  return (tabs || []).some((tab) => urlMatchesEnabledDomains(tab.url || "", domains));
}

async function fetchDomains() {
  try {
    const data = await gqlWs("query { domains { id domain media enabled } }", {});
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
    const matches = domainHostPatterns(d.domain);
    if (!matches.length) continue;
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

async function injectAnimeIntoTab(tabId, tabUrl, domains = null) {
  if (!Number.isInteger(tabId) || !/^https?:/i.test(tabUrl || "")) return false;
  const rows = domains || await cachedDomains();
  const allowed = rows.some((row) => row?.media === "ani" && row.enabled &&
    urlMatchesDomain(tabUrl, row.domain));
  if (!allowed) return false;
  try {
    if (chrome.scripting?.executeScript) {
      await chrome.scripting.executeScript({ target: { tabId }, files: MEDIA_JS.ani });
    } else if (chrome.tabs?.executeScript) {
      const api = typeof browser !== "undefined" ? browser : chrome;
      for (const file of MEDIA_JS.ani) await api.tabs.executeScript(tabId, { file });
    } else {
      return false;
    }
    return true;
  } catch (error) {
    console.debug("[DreaMedia] could not activate anime tracking in tab", tabId, error);
    return false;
  }
}

async function injectAnimeIntoOpenTabs(domains) {
  const animeDomains = domains.filter((row) => row?.media === "ani" && row.enabled);
  if (!animeDomains.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_error) { return; }
  for (const tab of tabs || []) {
    if (animeDomains.some((row) => urlMatchesDomain(tab.url || "", row.domain))) {
      await injectAnimeIntoTab(tab.id, tab.url, animeDomains);
    }
  }
}

async function refreshDomains() {
  try {
    const domains = await fetchDomains();
    await registerDomains(domains);
    await injectAnimeIntoOpenTabs(domains);
  } catch (e) {
    console.debug("[DreaMedia] domain refresh failed", e);
  }
}

async function refreshAll() {
  // Reapply the last synchronized set without opening a socket on a disallowed site.
  try {
    await registerDomains(await cachedDomains());
  } catch (e) {
    console.debug("[DreaMedia] cached domain registration failed", e);
  }
  if (!(await hasEnabledSiteTab())) {
    stopWsForNoEnabledSite();
    return;
  }
  // Start the single socket only while an enabled site is open.
  void ensureWs();
  await refreshDomains();
  if (await hasEnabledSiteTab()) {
    if (wsTransportResponsive()) await fetchBlocked();
  } else {
    stopWsForNoEnabledSite();
  }
}

// ---- single backend lane: authenticated graphql-transport-ws ----
// All extension GraphQL reads and writes use this one socket. The token is
// sent once in connection_init; extPing validates it before the socket is ready.

const M_PROGRESS = `mutation LiveProgress($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!, $eventTimeMs: String) {
  liveProgress(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds, eventTimeMs: $eventTimeMs)
}`;
const M_END = `mutation LiveEnd($entryId: Int!, $season: Int!, $episode: Int!, $positionSeconds: Int!, $eventTimeMs: String) {
  liveEnd(entryId: $entryId, season: $season, episode: $episode, positionSeconds: $positionSeconds, eventTimeMs: $eventTimeMs)
}`;
const Q_WS_AUTH_PROBE = "query { extPing }";
const WS_HANDSHAKE_TIMEOUT_MS = 15000;
const WS_PONG_TIMEOUT_MS = 10000;
const WS_OPERATION_TIMEOUT_MS = 120000;
const WS_RETRY_BASE_MS = 1000;
const WS_RETRY_MAX_MS = 30000;

let ws = null;
let wsReady = false;
let wsRetry = null;
let wsRetryAttempt = 0;
let wsAuthRejected = false;
let wsAuthFailureReason = "";
let wsKeepalive = null;
let wsPongTimer = null;
let wsPendingPong = null;
let wsPingSentAt = 0;
let wsLastPongAt = 0;
let wsHandshakeTimer = null;
let wsAuthProbeId = null;
let wsConnectPromise = null;
let wsGeneration = 0;
let gqlSeq = 0;
const pendingOps = new Map();
const wsReadyWaiters = new Set();

function wsTransportResponsive() {
  const heartbeatFresh = wsPendingPong
    ? Date.now() - wsPingSentAt <= WS_PONG_TIMEOUT_MS
    : Date.now() - wsLastPongAt <= WS_KEEPALIVE_INTERVAL_MS + WS_PONG_TIMEOUT_MS;
  return wsReady && ws?.readyState === WebSocket.OPEN && heartbeatFresh;
}

async function waitForWsReady(timeoutMs = 30000) {
  if (!(await hasEnabledSiteTab())) {
    stopWsForNoEnabledSite();
    throw new Error("Open an enabled site to connect");
  }
  if (wsAuthRejected) throw new Error(wsAuthFailureReason || "Extension token was rejected");
  if (wsTransportResponsive()) return Promise.resolve();
  if (wsReady) wsDead("WebSocket is not responsive");
  if (!(await backend()).token) throw new Error("Extension token is not configured");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      wsReadyWaiters.delete(onReady);
      reject(new Error("Authenticated WebSocket is unavailable"));
    }, timeoutMs);
    const onReady = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wsReadyWaiters.delete(onReady);
      if (error) reject(error);
      else resolve();
    };
    wsReadyWaiters.add(onReady);
    void ensureWs();
  });
}

async function gqlWs(query, variables = {}) {
  await waitForWsReady();
  return new Promise((resolve, reject) => {
    const id = String(++gqlSeq);
    const timer = setTimeout(() => {
      const pending = pendingOps.get(id);
      if (!pending) return;
      pendingOps.delete(id);
      try { ws?.send(JSON.stringify({ id, type: "complete" })); } catch (_e) { /* socket is closing */ }
      reject(new Error("WebSocket GraphQL operation timed out"));
    }, WS_OPERATION_TIMEOUT_MS);
    pendingOps.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, type: "subscribe", payload: { query, variables } }));
    } catch (error) {
      clearTimeout(timer);
      pendingOps.delete(id);
      reject(error);
      if (ws) wsDead(error.message || "WebSocket operation send failed");
    }
  });
}

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
    if (connectionState.status !== "connecting" || connectionState.reason !== "Reconnecting") {
      await commitConnectionState("connecting", "Reconnecting");
    }
    return;
  }
  if (status === "connecting") {
    await commitConnectionState("connecting", connectionFailureTimer ? "Reconnecting" : reason);
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
  if (wsPongTimer) {
    clearTimeout(wsPongTimer);
    wsPongTimer = null;
  }
  wsPendingPong = null;
  wsPingSentAt = 0;
}

function clearWsHandshakeTimer() {
  if (wsHandshakeTimer) {
    clearTimeout(wsHandshakeTimer);
    wsHandshakeTimer = null;
  }
}

function startWsKeepalive(socket) {
  stopWsKeepalive();
  const sendPing = () => {
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    wsPendingPong = true;
    wsPingSentAt = Date.now();
    try {
      // A matching pong proves the transport is alive and keeps MV3 active.
      socket.send(JSON.stringify({ type: "ping" }));
    } catch (error) {
      if (ws === socket) wsDead(error.message || "WebSocket keepalive failed");
      return;
    }
    wsPongTimer = setTimeout(() => {
      if (ws !== socket || !wsPendingPong) return;
      wsPongTimer = null;
      const reason = "WebSocket pong timed out";
      wsDead(reason);
      try { socket.close(4000, "DreaMedia heartbeat timeout"); } catch (_e) { /* already closed */ }
    }, WS_PONG_TIMEOUT_MS);
  };
  sendPing();
  wsKeepalive = setInterval(sendPing, WS_KEEPALIVE_INTERVAL_MS);
}

function wsDead(reason = "Connection closed", { authRejected = false, retry = true } = {}) {
  const deadSocket = ws;
  wsReady = false;
  ws = null;
  wsAuthProbeId = null;
  clearWsHandshakeTimer();
  stopWsKeepalive();
  if (authRejected) {
    wsAuthRejected = true;
    wsAuthFailureReason = reason || "Extension token was rejected; update it in DreaMedia settings";
    if (connectionFailureTimer) clearTimeout(connectionFailureTimer);
    connectionFailureTimer = null;
    pendingConnectionFailureReason = "";
    void commitConnectionState("disconnected", wsAuthFailureReason);
  } else {
    void publishConnectionState("disconnected", reason);
  }
  for (const operation of pendingOps.values()) {
    clearTimeout(operation.timer);
    operation.reject(new Error(reason));
  }
  pendingOps.clear();
  for (const onReady of [...wsReadyWaiters]) onReady(new Error(reason));
  try {
    if (deadSocket && deadSocket.readyState < WebSocket.CLOSING) deadSocket.close();
  } catch (_e) { /* retry below replaces the transport */ }
  if (retry && !authRejected) scheduleWsRetry();
}

function stopWsForNoEnabledSite() {
  const oldSocket = ws;
  if (!oldSocket && !wsReady && !wsRetry && !wsConnectPromise && !pendingOps.size &&
      !wsReadyWaiters.size && connectionState.status === "idle" &&
      connectionState.reason === "No enabled site open") return;
  wsGeneration += 1;
  wsReady = false;
  wsRetryAttempt = 0;
  ws = null;
  wsAuthProbeId = null;
  wsConnectPromise = null;
  clearWsHandshakeTimer();
  stopWsKeepalive();
  if (wsRetry) {
    clearTimeout(wsRetry);
    wsRetry = null;
  }
  for (const operation of pendingOps.values()) {
    clearTimeout(operation.timer);
    operation.reject(new Error("No enabled site is open"));
  }
  pendingOps.clear();
  for (const onReady of [...wsReadyWaiters]) onReady(new Error("No enabled site is open"));
  try {
    if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) {
      oldSocket.close(1000, "No enabled site open");
    }
  } catch (_e) { /* socket is already closing */ }
  void publishConnectionState("idle", "No enabled site open");
}

function scheduleWsRetry() {
  if (wsRetry || wsAuthRejected) return;
  const delay = Math.min(WS_RETRY_BASE_MS * (2 ** Math.min(wsRetryAttempt, 5)), WS_RETRY_MAX_MS);
  wsRetryAttempt += 1;
  wsRetry = setTimeout(() => {
    wsRetry = null;
    void ensureWs();
  }, delay);
}

async function ensureWs() {
  if (!(await hasEnabledSiteTab())) {
    stopWsForNoEnabledSite();
    return false;
  }
  if (wsAuthRejected) {
    await commitConnectionState(
      "disconnected",
      wsAuthFailureReason || "Extension token was rejected; update it in DreaMedia settings",
    );
    return false;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (wsConnectPromise) return wsConnectPromise;
  const generation = wsGeneration;
  const attempt = connectWs();
  wsConnectPromise = attempt;
  try {
    await attempt;
    return wsReady;
  } catch (error) {
    if (generation !== wsGeneration) return false;
    await publishConnectionState("disconnected", error.message || "WebSocket setup failed");
    scheduleWsRetry();
    return false;
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
  if (generation !== wsGeneration) return;
  if (!token) {
    await publishConnectionState("idle", "Not configured");
    return;
  }
  await publishConnectionState("connecting");
  if (generation !== wsGeneration) return;
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
    } else if (msg.type === "pong") {
      if (ws === socket && wsPendingPong) {
        if (wsPongTimer) clearTimeout(wsPongTimer);
        wsPongTimer = null;
        wsPendingPong = null;
        wsPingSentAt = 0;
        wsLastPongAt = Date.now();
      }
    } else if (msg.type === "next" || msg.type === "complete" || msg.type === "error") {
      if (msg.id === wsAuthProbeId) {
        if (msg.type !== "next" || msg.payload?.data?.extPing !== true || msg.payload?.errors?.length) {
          const detail = msg.payload?.errors?.[0]?.message;
          const failureReason = detail || "WebSocket authentication probe failed";
          const authRejected = /invalid|revoked|missing connection token|requires websocket authentication/i.test(failureReason);
          for (const onReady of [...wsReadyWaiters]) onReady(new Error(failureReason));
          try {
            if (socket.readyState < WebSocket.CLOSING) socket.close(4401, "Authentication probe failed");
          } catch (_e) { /* force local cleanup below */ }
          wsDead(failureReason, { authRejected, retry: !authRejected });
          return;
        }
        wsAuthProbeId = null;
        wsReady = true;
        wsRetryAttempt = 0;
        wsLastPongAt = Date.now();
        for (const onReady of [...wsReadyWaiters]) onReady();
        clearWsHandshakeTimer();
        if (wsRetry) {
          clearTimeout(wsRetry);
          wsRetry = null;
        }
        void publishConnectionState("connected");
        return;
      }
      const operation = pendingOps.get(msg.id);
      if (operation && msg.type !== "complete") {
        pendingOps.delete(msg.id);
        clearTimeout(operation.timer);
        if (msg.type === "next" && !msg.payload?.errors?.length) {
          operation.resolve(msg.payload?.data || {});
        } else {
          const error = msg.payload?.errors?.[0]?.message || msg.payload?.[0]?.message || "WebSocket GraphQL operation failed";
          operation.reject(new Error(error));
        }
      } else if (operation && msg.type === "complete") {
        pendingOps.delete(msg.id);
        clearTimeout(operation.timer);
        operation.reject(new Error("WebSocket GraphQL operation completed without a result"));
      }
    }
  };
  socket.onclose = (event) => {
    if (ws !== socket) return;
    const authRejected = event?.code === 4401 || event?.code === 4403;
    if (authRejected) {
      wsDead("Extension token rejected; update it in DreaMedia settings", { authRejected, retry: false });
      return;
    }
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
  try {
    const data = await gqlWs(query, variables);
    return data.liveProgress === true || data.liveEnd === true;
  } catch (_error) {
    return false;
  }
}

function reconnectAfterConfigurationChange() {
  wsAuthRejected = false;
  wsAuthFailureReason = "";
  wsRetryAttempt = 0;
  void (async () => {
    try { await chrome.storage.local.set({ domains: null }); } catch (_e) { /* next wake retries */ }
    stopWsForNoEnabledSite();
    void refreshAll();
  })();
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && (changes.backendUrl || changes.token)) {
    reconnectAfterConfigurationChange();
  }
});
const M_ANCHOR = `mutation Anchor($candidates: [String!]!, $pageUrl: String!, $seasonHint: Int, $episodeHint: Int) {
  anchorMatch(candidates: $candidates, pageUrl: $pageUrl, seasonHint: $seasonHint, episodeHint: $episodeHint) {
    entryId title season episode cursorSeason cursorEpisode blocked reason
  }
}`;

async function anchorBind(tabId, candidates, pageUrl, urlHint = {}) {
  const data = await gqlWs(M_ANCHOR, {
    candidates,
    pageUrl,
    seasonHint: urlHint.season ?? null,
    episodeHint: urlHint.episode ?? null,
  });
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
    title: match.title || "",
    season: match.season || match.cursorSeason || 1,
    episode: match.episode || match.cursorEpisode || 1,
    seasonSource: urlHint.season != null ? "url" : match.season != null ? "title" : "cursor",
    episodeSource: urlHint.episode != null ? "url" : match.episode != null ? "title" : "cursor",
  };
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
    const data = await gqlWs(Q_BLOCKED, {});
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
        case "dreamedia:connectionStatus":
          if (!(await hasEnabledSiteTab())) {
            stopWsForNoEnabledSite();
          } else if (connectionState.status === "connected") {
            if (!wsTransportResponsive()) {
              wsDead("WebSocket is not responsive");
              sendResponse({ ok: true, data: { status: "connecting", reason: "Reconnecting" } });
              break;
            }
          }
          sendResponse({ ok: true, data: connectionState });
          if (await hasEnabledSiteTab()) void ensureWs();
          break;
        case "dreamedia:connect":
          if (!(await hasEnabledSiteTab())) {
            stopWsForNoEnabledSite();
            sendResponse({ ok: true, data: connectionState });
            break;
          }
          await waitForWsReady();
          sendResponse({ ok: true, data: connectionState });
          break;
        case "dreamedia:subscribe": {
          const body = msg.body;
          const data = await gqlWs(
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
        case "dreamedia:startYoutubeImport": {
          const data = await gqlWs(
            `mutation StartYouTubeImport($links: [String!]!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
              startYoutubeImport(links: $links, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { jobId status requested processed resolved added skipped failed }
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
          sendResponse({ ok: true, data: data.startYoutubeImport });
          break;
        }
        case "dreamedia:youtubeImportStatus": {
          const data = await gqlWs(
            `query YoutubeImportJob($jobId: String!) {
              youtubeImportJob(jobId: $jobId) { jobId status requested processed resolved added skipped failed errors }
            }`,
            { jobId: msg.jobId },
          );
          sendResponse({ ok: true, data: data.youtubeImportJob });
          break;
        }
        case "dreamedia:cards":
          sendResponse({ ok: true, data: { cards: (await gqlWs("query { cards { id name done total } }", {})).cards } });
          break;
        case "dreamedia:addItem":
          sendResponse({
            ok: true,
            data: (await gqlWs(
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
              entries: (await gqlWs(
                "query { aniEntries { id title seasons cursorSeason cursorEpisode } }", {},
              )).aniEntries,
            },
          });
          break;
        case "dreamedia:categories":
          sendResponse({
            ok: true,
            data: {
              categories: (await gqlWs(
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
          sendResponse({ ok: true, data: await anchorBind(
            sender.tab?.id, msg.candidates, msg.url, msg.urlHint || {},
          ) });
          break;
        case "dreamedia:trackingStatus": {
          const tabId = Number(msg.tabId);
          if (!Number.isInteger(tabId)) throw new Error("No active tab to inspect");
          let data = null;
          try { data = await chrome.tabs.sendMessage(tabId, { type: "dreamedia:getTrackingStatus" }); }
          catch (_error) { /* the current page may predate allowlist activation */ }
          if (!data) {
            let tab = null;
            try { tab = await chrome.tabs.get(tabId); } catch (_error) { /* tab closed */ }
            if (tab?.url && await injectAnimeIntoTab(tabId, tab.url)) {
              try { data = await chrome.tabs.sendMessage(tabId, { type: "dreamedia:getTrackingStatus" }); }
              catch (_error) { /* page lifecycle or injection may still be settling */ }
            }
          }
          sendResponse({ ok: true, data: data || null });
          break;
        }
        case "dreamedia:domainStatus": {
          const host = normalizeDomain(msg.url);
          const hit = (await cachedDomains()).find(
            (d) => host === d.domain || host.endsWith(`.${d.domain}`),
          );
          sendResponse({ ok: true, host, registered: hit || null });
          break;
        }
        case "dreamedia:addDomain": {
          const domain = normalizeDomain(msg.domain);
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!domain || !urlMatchesDomain(activeTab?.url || "", domain)) {
            throw new Error("Open the site in the active tab to enable it.");
          }
          pendingSiteDomains.add(domain);
          try {
            const data = await gqlWs(
              `mutation AddDomain($domain: String!, $media: String!) {
                addDomain(domain: $domain, media: $media) { id domain media enabled }
              }`,
              { domain: msg.domain, media: msg.media },
            );
            await refreshDomains();
            sendResponse({ ok: true, data });
          } finally {
            pendingSiteDomains.delete(domain);
            if (await hasEnabledSiteTab()) void ensureWs();
            else stopWsForNoEnabledSite();
          }
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
// initialized. No socket is opened unless an enabled site tab is present.
chrome.runtime.onStartup?.addListener(() => void refreshAll());
chrome.runtime.onInstalled?.addListener(() => void refreshAll());
chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") void refreshAll();
});
chrome.tabs?.onActivated?.addListener(() => void refreshAll());
chrome.tabs?.onRemoved?.addListener(() => void refreshAll());
chrome.alarms?.create("dreamedia:domains", { periodInMinutes: 5 });
chrome.alarms?.create("dreamedia:ws-watchdog", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamedia:domains") void refreshAll();
  if (alarm.name === "dreamedia:ws-watchdog") void ensureWs();
});
void refreshAll(); // service-worker wake / persistent background load; still site-gated
