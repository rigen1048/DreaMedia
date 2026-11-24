
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
