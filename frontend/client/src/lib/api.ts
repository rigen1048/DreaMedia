export class BackendError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "BackendError"; }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${import.meta.env.VITE_DREAMEDIA_API_BASE ?? ""}${path}`, { ...init, headers, credentials: "include" });
  } catch {
    throw new BackendError("Could not reach the DreaMedia backend. Start the backend and PostgreSQL, then retry.");
  }
  const type = response.headers.get("content-type") ?? "";
  const payload: unknown = type.includes("json") ? await response.json() : await response.text();
  if (response.status === 401) throw new BackendError("Your session has expired. Sign in again.", 401);
  if (!response.ok) {
    const detail = typeof payload === "object" && payload !== null && "detail" in payload ? String((payload as { detail: unknown }).detail) : `Backend request failed (${response.status}).`;
    throw new BackendError(detail, response.status);
  }
  if (typeof payload === "object" && payload !== null && "ok" in payload && (payload as { ok: unknown }).ok === false) throw new BackendError(String((payload as { error?: unknown }).error ?? "The backend rejected this change."));
  return payload as T;
}
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export type YtKind = "tracking" | "wordscan" | "playlist" | "random";
export type YtVideo = { title: string | null; url: string | null; thumbnail: string | null; published_at: number | null; seen: boolean; channel: string | null };
export type YtChannel = { id: number; name: string | null; url: string | null; label: "none" | "reserved" | "blocked"; label_reason: string | null; rss_id: string | null; kind: YtKind | null; domain: string; subdomain: string };
export type SidebarDomain = { key: string; name: string; active: boolean; subdomains: { key: string; name: string; active: boolean }[] };
export type AniEvent = { id: number; season_no: number | null; kind: string; tier: "awaited" | "unwatched"; seen: boolean; created_at: string; payload: Record<string, unknown> };
export type AniSeason = { season_no: number; status: string | null; episodes_total: number | null; episodes_aired: number | null; state: "unknown" | "announced" | "airing" | "finished"; watched: boolean };
export type AniEntry = { id: number; title: string | null; label: "none" | "completed" | "blocked"; list: "watchlist" | "confirmed" | "watching"; active: boolean; notify_release: boolean; last_watched_episode: number | null; last_watched_at: number | null; total_seasons: number; seasons: AniSeason[] };
export type SubscribeInput = { kind: YtKind; link: string; channel_name: string; channel_url: string; words?: string[]; rank?: string };

export const api = {
  auth: {
    login: (username: string, password: string) => request<{ ok: true; user_id: number; username: string; role: string }>("/auth/login", post({ username, password })),
    signup: (username: string, password: string) => request<{ ok: true; user_id: number; username: string; role: string }>("/auth/signup", post({ username, password })),
    logout: () => request<{ ok: true }>("/auth/logout", post({})),
  },
  yt: {
    videos: (limit = 500) => request<{ videos: YtVideo[] }>(`/yt/feed/videos?limit=${limit}`),
    sidebar: () => request<{ domains: SidebarDomain[] }>("/yt/feed/sidebar"),
    channels: (includeBlocked = true) => request<{ channels: YtChannel[] }>(`/yt/feed/channels?include_blocked=${includeBlocked}`),
    subscribe: (input: SubscribeInput) => request<{ ok: true; channel_id: number }>("/yt/access/subscribe", post(input)),
    setChannelLabel: (id: number, label: YtChannel["label"], reason?: string) => request<{ ok: true }>(`/yt/access/channels/${id}/label`, post({ label, reason })),
    assignChannel: (id: number, domain: string, subdomain: string | null) => request<{ ok: true }>(`/yt/access/channels/${id}/assign`, post({ domain, subdomain })),
    deleteChannel: (id: number) => request<{ ok: true }>(`/yt/access/channels/${id}/delete`, post({})),
    setCategoryActive: (domain: string, subdomain: string | null, active: boolean) => request<{ ok: true }>("/yt/access/category/active", post({ domain, subdomain, active })),
  },
  ani: {
    events: (includeSeen = true) => request<{ events: AniEvent[] }>(`/ani/feed/events?include_seen=${includeSeen}`),
    management: () => request<{ entries: AniEntry[] }>("/ani/feed/management"),
    track: (title: string, list_kind: AniEntry["list"]) => request<{ ok: true; entry_id: number; seasons: number }>("/ani/access/track", post({ title, list_kind })),
    updateEntry: (id: number, patch: Partial<Pick<AniEntry, "label" | "active" | "notify_release" | "last_watched_episode">> & { list_kind?: AniEntry["list"]; label_reason?: string }) => request<{ ok: true; id: number }>(`/ani/access/entries/${id}`, post(patch)),
    setSeasonWatched: (entryId: number, seasonNo: number, watched: boolean) => request<{ ok: true }>(`/ani/access/entries/${entryId}/seasons/${seasonNo}/watched`, post({ watched })),
    deleteEntry: (id: number) => request<{ ok: true }>(`/ani/access/entries/${id}/delete`, post({})),
  },
};
