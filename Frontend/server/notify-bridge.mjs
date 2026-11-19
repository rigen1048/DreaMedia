#!/usr/bin/env node
/**
 * DreaMedia notification bridge.
 *
 * The backend owns notification *production*; the frontend owns this REST
 * receiver. The bell in the UI reads only from here (list + SSE), so feed
 * rows can never leak into the bell lane.
 *
 * Endpoints
 *   POST /api/notifications        backend push (token protected)
 *   GET  /api/notifications        list for one user (?userId=&limit=)
 *   POST /api/notifications/seen   mark messages seen ({userId, ids})
 *   GET  /api/notifications/stream SSE stream for one user (?userId=)
 *   GET  /health                   liveness + counters
 *
 * Zero runtime dependencies; state is an append-only JSON file.
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || process.env.PORT || 3100);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const TOKEN = process.env.FRONTEND_NOTIFY_TOKEN || "";
// Fail closed (2026 review): an empty token used to disable auth on the push
// lane. Now a tokenless bridge refuses every push and says so at boot.
if (!TOKEN) {
  console.warn(
    "[bridge] FRONTEND_NOTIFY_TOKEN is empty — push endpoint REJECTS all posts. " +
    "Set it in the root .env (start.py generates one on first run).",
  );
}
const STORE = resolve(process.env.BRIDGE_STORE || `${HERE}/../.bridge/inbox.json`);
const ORIGIN = process.env.BRIDGE_ALLOW_ORIGIN || "*";
// Reads are authenticated by asking the backend who owns the browser cookie.
// A guessed ?userId therefore cannot read somebody else's bell.
const BACKEND_URL = (process.env.BRIDGE_BACKEND_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const MAX = Number(process.env.BRIDGE_MAX_MESSAGES || 800);

/** @type {{ messages: any[] }} */
let state = { messages: [] };
try {
  state = JSON.parse(readFileSync(STORE, "utf8"));
  if (!Array.isArray(state.messages)) state.messages = [];
} catch {
  /* first boot */
}

let flushTimer = null;
function persist() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      mkdirSync(dirname(STORE), { recursive: true });
      const tmp = `${STORE}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, STORE);
    } catch (error) {
      console.error("[bridge] persist failed:", error.message);
    }
  }, 120);
}

/** @type {Set<{ res: import("node:http").ServerResponse; userId: number | null }>} */
const clients = new Set();

function sseSend(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function broadcast(message) {
  for (const client of clients) {
    if (client.userId === null || client.userId === message.userId) {
      // default SSE event name is "message", which the client listens for
      sseSend(client, "message", message);
    }
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** cookie → { userId, expires } | null, cached briefly to spare the backend. */
const sessionCache = new Map();

async function sessionUser(req) {
  const cookie = req.headers.cookie || "";
  if (!cookie) return null;
  const hit = sessionCache.get(cookie);
  if (hit && hit.expires > Date.now()) return hit.userId;
  let userId = null;
  try {
    const response = await fetch(`${BACKEND_URL}/auth/session`, {
      headers: { cookie },
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const body = await response.json();
      userId = Number(body.userId) || null;
    }
  } catch {
    return null; // backend unreachable: treat as unauthenticated, stay quiet
  }
  if (sessionCache.size > 200) sessionCache.clear();
  sessionCache.set(cookie, { userId, expires: Date.now() + 10_000 });
  return userId;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Dreamedia-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("payload too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalise(input) {
  const now = new Date().toISOString();
  return {
    id: String(input.id ?? randomUUID()),
    rowId: input.rowId ?? null,
    userId: Number(input.userId ?? 0),
    media: String(input.media ?? "system"),
    kind: String(input.kind ?? "message"),
    title: String(input.title ?? "Notification"),
    message: String(input.message ?? ""),
    level: String(input.level ?? "info"),
    url: input.url ?? null,
    createdAt: input.createdAt ?? now,
    payload: input.payload ?? {},
    seen: Boolean(input.seen),
    receivedAt: now,
  };
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    return json(res, 200, {
      ok: true,
      service: "dreamedia-notify-bridge",
      messages: state.messages.length,
      subscribers: clients.size,
      tokenProtected: true,
    });
  }

  if (path === "/api/notifications/stream" && req.method === "GET") {
    const userId = await sessionUser(req);
    if (!userId) return json(res, 401, { ok: false, error: "unauthenticated" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    const client = { res, userId };
    clients.add(client);
    sseSend(client, "ready", { ok: true, subscribers: clients.size });

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        clients.delete(client);
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
    return;
  }

  if (path === "/api/notifications" && req.method === "GET") {
    const userId = await sessionUser(req);
    if (!userId) return json(res, 401, { ok: false, error: "unauthenticated" });
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 300);
    const list = state.messages
      .filter((message) => !userId || message.userId === userId)
      .slice(-limit)
      .reverse();
    return json(res, 200, {
      messages: list,
      unseen: list.filter((message) => !message.seen).length,
      online: true,
    });
  }

  if (path === "/api/notifications" && req.method === "POST") {
    // Empty token = closed lane (fail-closed), not open (2026 review).
    if (!TOKEN || req.headers["x-dreamedia-token"] !== TOKEN) {
      return json(res, 401, { ok: false, error: "invalid bridge token" });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
    const message = normalise(body);
    if (!message.userId) return json(res, 400, { ok: false, error: "userId required" });

    const existing = state.messages.findIndex((item) => item.id === message.id);
    if (existing >= 0) state.messages[existing] = message;
    else state.messages.push(message);
    if (state.messages.length > MAX) state.messages = state.messages.slice(-MAX);
    persist();
    broadcast(message);
    console.log(`[bridge] push ${message.media}/${message.kind} → user ${message.userId}`);
    return json(res, 202, { ok: true, id: message.id, subscribers: clients.size });
  }

  if (path === "/api/notifications/seen" && req.method === "POST") {
    const userId = await sessionUser(req);
    if (!userId) return json(res, 401, { ok: false, error: "unauthenticated" });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
    const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
    let changed = 0;
    for (const message of state.messages) {
      if (userId && message.userId !== userId) continue;
      if (ids.size && !ids.has(message.id)) continue;
      if (!message.seen) {
        message.seen = true;
        changed += 1;
      }
    }
    if (changed) persist();
    return json(res, 200, { ok: true, changed });
  }

  if (path === "/api/notifications/clear" && req.method === "POST") {
    const userId = await sessionUser(req);
    if (!userId) return json(res, 401, { ok: false, error: "unauthenticated" });
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      /* ignore */
    }
    state.messages = userId ? state.messages.filter((message) => message.userId !== userId) : [];
    persist();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] DreaMedia notify bridge on http://${HOST}:${PORT}`);
  console.log(`[bridge] store=${STORE} token=${TOKEN ? "required" : "CLOSED (unset)"}`);
});

function shutdown() {
  for (const client of clients) {
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
