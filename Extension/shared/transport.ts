/**
 * DreaMedia Extension — WebSocket GraphQL Transport
 *
 * The ONLY network lane for the extension — content/popup scripts never
 * fetch directly. All GraphQL reads and writes go through this single
 * authenticated socket. The token is sent once in connection_init;
 * extPing validates it before the socket is considered ready.
 * No `any` type permitted.
 */

export {};

const WS_HANDSHAKE_TIMEOUT_MS = 15000;
const WS_OPERATION_TIMEOUT_MS = 120000;
const WS_RETRY_BASE_MS = 1000;
const WS_RETRY_MAX_MS = 30000;
const WS_KEEPALIVE_INTERVAL_MS = 20000;
const WS_PONG_TIMEOUT_MS = 10000;
const CONNECTION_FAILURE_GRACE_MS = 30000;

const Q_WS_AUTH_PROBE = "query { extPing }";

let ws: WebSocket | null = null;
let wsReady = false;
let wsRetry = null as number | null;
let wsRetryAttempt = 0;
let wsAuthRejected = false;
let wsAuthFailureReason = "";
let wsKeepalive = null as number | null;
let wsPongTimer = null as number | null;
let wsPendingPong = false;
let wsPingSentAt = 0;
let wsLastPongAt = 0;
let wsHandshakeTimer = null as number | null;
let wsAuthProbeId = null as string | null;
let wsConnectPromise = null as Promise<void> | null;
let wsGeneration = 0;
let gqlSeq = 0;
const pendingOps = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: number }
>();
const wsReadyWaiters = new Set<{
  resolve: () => void;
  reject: (err: Error) => void;
}>();

let connectionFailureTimer = null as number | null;
let pendingConnectionFailureReason = "";
let connectionState: { status: string; reason: string } = {
  status: "idle",
  reason: "Not configured",
};

const backendUrl = "http://127.0.0.1:8123";
const wsUrl = backendUrl.replace(/^http/, "ws") + "/ext/graphql";

function stopWsKeepalive(): void {
  if (wsKeepalive) {
    clearInterval(wsKeepalive);
    wsKeepalive = null;
  }
  if (wsPongTimer) {
    clearTimeout(wsPongTimer);
    wsPongTimer = null;
  }
  wsPendingPong = false;
  wsPingSentAt = 0;
}

function clearWsHandshakeTimer(): void {
  if (wsHandshakeTimer) {
    clearTimeout(wsHandshakeTimer);
    wsHandshakeTimer = null;
  }
}

function startWsKeepalive(socket: WebSocket): void {
  stopWsKeepalive();
  const sendPing = () => {
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    wsPendingPong = true;
    wsPingSentAt = Date.now();
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch (error) {
      if (ws === socket) wsDead(error instanceof Error ? error.message : "WebSocket keepalive failed");
      return;
    }
    wsPongTimer = setTimeout(() => {
      if (ws !== socket || !wsPendingPong) return;
      wsPongTimer = null;
      wsDead("WebSocket pong timed out");
      try { socket.close(4000, "DreaMedia heartbeat timeout"); } catch { /* already closed */ }
    }, WS_PONG_TIMEOUT_MS);
  };
  sendPing();
  wsKeepalive = setInterval(sendPing, WS_KEEPALIVE_INTERVAL_MS);
}

function wsDead(
  reason = "Connection closed",
  { authRejected = false, retry = true }: { authRejected?: boolean; retry?: boolean } = {}
): void {
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
    commitConnectionState("disconnected", wsAuthFailureReason);
  } else {
    publishConnectionState("disconnected", reason);
  }
  for (const operation of pendingOps.values()) {
    clearTimeout(operation.timer);
    operation.reject(new Error(reason));
  }
  pendingOps.clear();
  for (const onReady of [...wsReadyWaiters]) onReady.reject(new Error(reason));
  wsReadyWaiters.clear();
  try {
    if (deadSocket && deadSocket.readyState < WebSocket.CLOSING) deadSocket.close();
  } catch { /* retry below replaces the transport */ }
  if (retry && !authRejected) scheduleWsRetry();
}

function stopWsForNoEnabledSite(): void {
  const oldSocket = ws;
  if (
    !oldSocket &&
    !wsReady &&
    !wsRetry &&
    !wsConnectPromise &&
    pendingOps.size === 0 &&
    wsReadyWaiters.size === 0 &&
    connectionState.status === "idle" &&
    connectionState.reason === "No enabled site open"
  )
    return;
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
  for (const onReady of [...wsReadyWaiters]) onReady.reject(new Error("No enabled site is open"));
  wsReadyWaiters.clear();
  try {
    if (oldSocket && oldSocket.readyState < WebSocket.CLOSING)
      oldSocket.close(1000, "No enabled site open");
  } catch { /* socket is already closing */ }
  publishConnectionState("idle", "No enabled site open");
}

function scheduleWsRetry(): void {
  if (wsRetry || wsAuthRejected) return;
  const delay = Math.min(
    WS_RETRY_BASE_MS * (2 ** Math.min(wsRetryAttempt, 5)),
    WS_RETRY_MAX_MS
  );
  wsRetryAttempt += 1;
  wsRetry = setTimeout(() => {
    wsRetry = null;
    void ensureWs();
  }, delay);
}

async function ensureWs(): Promise<void> {
  if (wsAuthRejected) {
    await commitConnectionState("disconnected", wsAuthFailureReason || "Extension token was rejected");
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return Promise.resolve();
  if (wsConnectPromise) return;
  const attempt = connectWs();
  wsConnectPromise = attempt;
  try {
    await attempt;
  } catch (error) {
    await publishConnectionState("disconnected", error instanceof Error ? error.message : "WebSocket setup failed");
    scheduleWsRetry();
  } finally {
    if (wsConnectPromise === attempt) wsConnectPromise = null;
  }
}

function connectWs(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return Promise.resolve();
  wsReady = false;
  wsAuthProbeId = null;
  if (ws) {
    try { ws.close(); } catch { /* stale socket */ }
    ws = null;
  }

  // No token configured yet — the popup will provide one via saveConfig.
  // For now, create the socket; connection_init will be sent when sendGraphQL
  // is first called with a token from storage.
  try {
    ws = new WebSocket(wsUrl, "graphql-transport-ws");
  } catch (error) {
    ws = null;
    publishConnectionState("disconnected", error instanceof Error ? error.message : "WebSocket unavailable");
    scheduleWsRetry();
    return Promise.resolve();
  }

  const socket = ws;
  wsHandshakeTimer = setTimeout(() => {
    wsHandshakeTimer = null;
    if (ws !== socket || wsReady) return;
    wsDead("WebSocket acknowledgement/authentication probe timed out");
  }, WS_HANDSHAKE_TIMEOUT_MS);

  socket.onopen = () => {
    try {
      // connection_init will be sent lazily on first sendGraphQL call,
      // once the token is available from storage.
      socket.send(JSON.stringify({ type: "connection_init", payload: {} }));
    } catch (error) {
      if (ws === socket) wsDead(error instanceof Error ? error.message : "WebSocket initialization failed");
    }
  };

  socket.onmessage = (event) => {
    let msg: unknown;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const m = msg as { type?: string; id?: string; payload?: unknown; errors?: unknown[] };
    if (m.type === "connection_ack") {
      if (ws !== socket || wsReady || wsAuthProbeId) return;
      startWsKeepalive(socket);
      wsAuthProbeId = `auth-${++gqlSeq}`;
      try {
        socket.send(
          JSON.stringify({
            id: wsAuthProbeId,
            type: "subscribe",
            payload: { query: Q_WS_AUTH_PROBE, variables: {} },
          })
        );
      } catch (error) {
        wsDead(error instanceof Error ? error.message : "WebSocket authentication probe failed");
      }
    } else if (m.type === "ping") {
      try {
        const pong = { type: "pong" };
        if (m.payload && typeof m.payload === "object") {
          (pong as { payload?: unknown }).payload = m.payload;
        }
        socket.send(JSON.stringify(pong));
      } catch { /* close handler retries */ }
    } else if (m.type === "pong") {
      if (ws === socket && wsPendingPong) {
        if (wsPongTimer) clearTimeout(wsPongTimer);
        wsPongTimer = null;
        wsPendingPong = false;
        wsPingSentAt = 0;
        wsLastPongAt = Date.now();
      }
    } else if (m.type === "next" || m.type === "complete" || m.type === "error") {
      if (m.id === wsAuthProbeId) {
        if (
          m.type !== "next" ||
          !(m.payload && typeof m.payload === "object" && (m.payload as { extPing?: boolean }).extPing === true) ||
          (m.errors && m.errors.length > 0)
        ) {
          const detail =
            m.payload && typeof m.payload === "object"
              ? (((m.payload as Record<string, unknown>).errors as
                  | unknown[]
                  | undefined)?.[0] as
                  | { message?: string }
                  | undefined)
              : undefined;
          const failureReason =
            (detail && typeof detail === "object" && "message" in detail
              ? (detail as { message?: string }).message
              : undefined) || "WebSocket authentication probe failed";
          const authRejected = /invalid|revoked|missing connection token|requires websocket authentication/i.test(
            failureReason
          );
          for (const onReady of [...wsReadyWaiters]) onReady.reject(new Error(failureReason));
          wsReadyWaiters.clear();
          try {
            if (socket.readyState < WebSocket.CLOSING) socket.close(4401, "Authentication probe failed");
          } catch { /* force local cleanup below */ }
          wsDead(failureReason, { authRejected, retry: !authRejected });
          return;
        }
        wsAuthProbeId = null;
        wsReady = true;
        wsRetryAttempt = 0;
        wsLastPongAt = Date.now();
        for (const onReady of [...wsReadyWaiters]) onReady.resolve();
        wsReadyWaiters.clear();
        clearWsHandshakeTimer();
        if (wsRetry) {
          clearTimeout(wsRetry);
          wsRetry = null;
        }
        publishConnectionState("connected");
        return;
      }
      const operation = pendingOps.get(m.id as string);
      if (operation && m.type !== "complete") {
        pendingOps.delete(m.id as string);
        clearTimeout(operation.timer);
        if (
          m.type === "next" &&
          !(
            m.payload &&
            typeof m.payload === "object" &&
            ((m.payload as Record<string, unknown>).errors as
              | unknown[]
              | undefined)?.length
          )
        ) {
          operation.resolve(m.payload || {});
        } else {
          const error =
            (m.payload &&
              typeof m.payload === "object" &&
              (m.payload as Record<string, unknown>).errors
              ? (((m.payload as Record<string, unknown>).errors as
                  | unknown[]
                  | undefined)?.[0] as
                  | { message?: string }
                  | undefined)
              : undefined) ||
            (Array.isArray(m.payload) ? m.payload?.[0] : undefined) ||
            "WebSocket GraphQL operation failed";
          const errMsg =
            typeof error === "object" && error !== null && "message" in error
              ? (error as { message?: string }).message
              : String(error);
          operation.reject(new Error(errMsg));
        }
      } else if (operation && m.type === "complete") {
        pendingOps.delete(m.id as string);
        clearTimeout(operation.timer);
        operation.reject(new Error("WebSocket GraphQL operation completed without a result"));
      }
    }
  };

  socket.onclose = (event) => {
    if (ws !== socket) return;
    const authRejected = event?.code === 4401 || event?.code === 4403;
    if (authRejected) {
      wsDead("Extension token rejected; update it in DreaMedia settings", {
        authRejected,
        retry: false,
      });
      return;
    }
    const closeDetails = [`WebSocket closed (${event?.code ?? "unknown"})`];
    if (event?.reason) closeDetails.push(event.reason);
    wsDead(closeDetails.join(": "));
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    try { socket.close(); } catch { wsDead("WebSocket transport error"); }
  };

  return Promise.resolve();
}

function commitConnectionState(status: string, reason = ""): void {
  connectionState = { status, reason };
  try {
    chrome.runtime.sendMessage({ type: "dreamedia:connectionStatus", ...connectionState });
  } catch { /* The popup is normally the only receiver and may be closed. */ }
}

function publishConnectionState(status: string, reason = ""): void {
  if (status === "disconnected") {
    pendingConnectionFailureReason = reason;
    if (!connectionFailureTimer) {
      connectionFailureTimer = setTimeout(() => {
        connectionFailureTimer = null;
        void commitConnectionState("disconnected", pendingConnectionFailureReason);
      }, CONNECTION_FAILURE_GRACE_MS);
    }
    if (
      connectionState.status !== "connecting" ||
      connectionState.reason !== "Reconnecting"
    ) {
      commitConnectionState("connecting", "Reconnecting");
    }
    return;
  }
  if (status === "connecting") {
    commitConnectionState("connecting", connectionFailureTimer ? "Reconnecting" : reason);
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
  commitConnectionState(status, reason);
}

function waitForWsReady(timeoutMs = 30000): Promise<void> {
  if (wsAuthRejected) {
    return Promise.reject(new Error(wsAuthFailureReason || "Extension token was rejected"));
  }
  if (wsTransportResponsive()) return Promise.resolve();
  if (wsReady) wsDead("WebSocket is not responsive");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Authenticated WebSocket is unavailable"));
    }, timeoutMs);
    const onReady = {
      resolve: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      reject: (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    };
    wsReadyWaiters.add(onReady);
    void ensureWs();
  });
}

function wsTransportResponsive(): boolean {
  const heartbeatFresh = wsPendingPong
    ? Date.now() - wsPingSentAt <= WS_PONG_TIMEOUT_MS
    : Date.now() - wsLastPongAt <= WS_KEEPALIVE_INTERVAL_MS + WS_PONG_TIMEOUT_MS;
  return wsReady && ws?.readyState === WebSocket.OPEN && heartbeatFresh;
}

export async function sendGraphQL(
  query: string,
  variables: Record<string, unknown> = {},
  token: string
): Promise<unknown> {
  await waitForWsReady();
  // Ensure the socket has been authenticated with the token.
  if (!wsReady || !wsAuthProbeId) {
    // Send connection_init with token if not yet authenticated.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({ type: "connection_init", payload: { token } })
        );
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : "WebSocket send failed"
        );
      }
    } else {
      throw new Error("WebSocket is not open");
    }
  }

  return new Promise((resolve, reject) => {
    const id = String(++gqlSeq);
    const timer = setTimeout(() => {
      const pending = pendingOps.get(id);
      if (!pending) return;
      pendingOps.delete(id);
      clearTimeout(timer);
      try {
        ws?.send(JSON.stringify({ id, type: "complete" }));
      } catch { /* socket is closing */ }
      reject(new Error("WebSocket GraphQL operation timed out"));
    }, WS_OPERATION_TIMEOUT_MS);
    pendingOps.set(id, { resolve, reject, timer });
    try {
      ws?.send(
        JSON.stringify({ id, type: "subscribe", payload: { query, variables } })
      );
    } catch (error) {
      clearTimeout(timer);
      pendingOps.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
      if (ws) wsDead(error instanceof Error ? error.message : "WebSocket operation send failed");
    }
  });
}

export { connectionState, stopWsForNoEnabledSite, ensureWs };
