import type { BellMessage } from "./types";

export class NotificationApiError extends Error {
  constructor(public readonly status: number) {
    super(`notifications ${status}`);
  }
}

export async function listMessages(): Promise<BellMessage[]> {
  const response = await fetch("/notifications?limit=100", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new NotificationApiError(response.status);
  const payload = (await response.json()) as { notifications?: BellMessage[] };
  return payload.notifications ?? [];
}

export async function markMessagesSeen(ids: number[], seen = true): Promise<void> {
  if (!ids.length) return;
  const response = await fetch("/notifications/seen", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, seen }),
  });
  if (!response.ok) throw new NotificationApiError(response.status);
}
