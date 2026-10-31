import { post, request } from "../../../shared/api/http";

export type AniEvent = {
  id: number;
  entry_id: number;
  season_no: number | null;
  kind: string;
  tier: "awaited" | "unwatched";
  seen: boolean;
  created_at: string;
  payload: Record<string, unknown>;
};

export type AniSeason = {
  season_no: number;
  title: string | null;
  status: string | null;
  episodes_total: number | null;
  episodes_aired: number | null;
  state: "unknown" | "announced" | "airing" | "finished";
  watched: boolean;
  start_date: string | null;
  release_date: string | null;
};

export type AniCursor = {
  season: number | null;
  episode: number | null;
  position_seconds: number | null;
};

export type AniEntry = {
  id: number;
  title: string | null;
  cover: string | null;
  label: "none" | "completed" | "blocked";
  list: "watchlist" | "confirmed" | "watching";
  active: boolean;
  notify_release: boolean;
  canon_only: boolean;
  cursor: AniCursor;
  total_seasons: number;
  seasons: AniSeason[];
};

export type AniEntryPatch = Partial<
  Pick<AniEntry, "label" | "active" | "notify_release" | "canon_only">
> & {
  list_kind?: AniEntry["list"];
  label_reason?: string;
};

export const aniApi = {
  events: (includeSeen = true) =>
    request<{ events: AniEvent[] }>(`/ani/feed/events?include_seen=${includeSeen}`),
  management: () => request<{ entries: AniEntry[] }>("/ani/feed/management"),
  track: (title: string, list_kind: AniEntry["list"]) =>
    request<{ ok: true; entry_id: number; seasons: number }>(
      "/ani/access/track",
      post({ title, list_kind }),
    ),
  updateEntry: (id: number, patch: AniEntryPatch) =>
    request<{ ok: true; id: number }>(`/ani/access/entries/${id}`, post(patch)),
  setSeasonWatched: (entryId: number, seasonNo: number, watched: boolean) =>
    request<{ ok: true }>(
      `/ani/access/entries/${entryId}/seasons/${seasonNo}/watched`,
      post({ watched }),
    ),
  setCursor: (
    entryId: number,
    season: number,
    episode: number | null,
    position_seconds: number | null,
  ) =>
    request<{
      ok: true;
      season: number;
      episode: number | null;
      position_seconds: number | null;
    }>(`/ani/access/entries/${entryId}/cursor`, post({ season, episode, position_seconds })),
  markRange: (entryId: number, from_season: number, to_season: number) =>
    request<{
      ok: true;
      watched_seasons: number;
      cursor: { season: number; episode: number | null };
    }>(`/ani/access/entries/${entryId}/range`, post({ from_season, to_season })),
  markAllWatched: (entryId: number) =>
    request<{
      ok: true;
      watched_seasons: number;
      cursor: { season: number; episode: number | null };
    }>(`/ani/access/entries/${entryId}/watched-all`, post({})),
  markEventsSeen: (event_ids: number[], seen = true) =>
    request<{ ok: true; changed: number }>("/ani/access/events/seen", post({ event_ids, seen })),
  deleteEntry: (id: number) => request<{ ok: true }>(`/ani/access/entries/${id}/delete`, post({})),
};
