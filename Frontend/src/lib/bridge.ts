import type { BellMessage } from "./types";

/**
 * The bell is fed exclusively by the frontend's own REST receiver.
 * The backend POSTs messages to that receiver; this module reads and
 * acknowledges them. Feed rows never enter this lane.
 */
const BASE = import.meta.env.VITE_NOTIFY_BRIDGE_BASE ?? "/bridge";

type BridgeEnvelope = {
  messages: BellMessage[];
  online: boolean;
};

export async function listMessages(userId: number): Promise<BridgeEnvelope> {
  const response = await fetch(`${BASE}/api/notifications?userId=${userId}`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`bridge ${response.status}`);
  const payload = (await response.json()) as { messages?: BellMessage[] };
  return { messages: payload.messages ?? [], online: true };
}

export async function markMessagesSeen(userId: number, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await fetch(`${BASE}/api/notifications/seen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, ids }),
  });
}

export function openMessageStream(
  userId: number,
  onMessage: (message: BellMessage) => void,
  onStatus?: (online: boolean) => void,
): () => void {
  let source: EventSource | null = null;
  let retry: number | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    source = new EventSource(`${BASE}/api/notifications/stream?userId=${userId}`);
    source.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as BellMessage;
        onMessage(parsed);
        onStatus?.(true);
      } catch {
        /* ignore malformed frames */
      }
    });
    source.addEventListener("open", () => onStatus?.(true));
    source.addEventListener("error", () => {
      onStatus?.(false);
      source?.close();
      if (!closed) retry = window.setTimeout(connect, 4000);
    });
  };

  connect();
  return () => {
    closed = true;
    if (retry) window.clearTimeout(retry);
    source?.close();
  };
}
