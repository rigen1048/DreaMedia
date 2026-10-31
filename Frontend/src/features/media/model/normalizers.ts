import type { AniEntry, AniSeason as ApiAniSeason, BackendNotification } from "../api";
import type { AnimeSeason, AnimeTrack, BellNotification } from "../types";

export const colors = ["lime", "violet", "blue", "orange", "gold"];

const kindName = {
  tracking: "Track",
  wordscan: "Wordscan",
  playlist: "Playlist",
  random: "Random",
} as const;

export function relTime(input: number | string | null | undefined): string {
  if (!input) return "—";
  const date =
    typeof input === "number"
      ? new Date(input < 10_000_000_000 ? input * 1000 : input)
      : new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : date.toLocaleDateString();
}

export function pretty(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeSeason(season: ApiAniSeason): AnimeSeason {
  return {
    id: String(season.season_no),
    seasonNo: season.season_no,
    label: `Season ${season.season_no}`,
    name: season.title ?? `Season ${season.season_no}`,
    episodes: season.episodes_total ?? 0,
    aired: season.episodes_aired ?? 0,
    watched: season.watched,
    status:
      season.watched || season.state === "finished"
        ? "Completed"
        : season.state === "airing" || season.state === "announced"
          ? "Releasing"
          : "Planned",
    state: season.state,
    startDate: season.start_date,
    releaseDate: season.release_date,
  };
}

export function normalizeAnime(entry: AniEntry): AnimeTrack {
  const seasons = entry.seasons.map(normalizeSeason);
  const status =
    entry.label === "completed" || (seasons.length > 0 && seasons.every((season) => season.watched))
      ? "Completed"
      : seasons.some((season) => season.status === "Releasing")
        ? "Releasing"
        : entry.list === "watching"
          ? "Watching"
          : "Planned";

  return {
    id: String(entry.id),
    backendId: entry.id,
    title: entry.title ?? "Untitled anime",
    cover: entry.cover ?? "",
    status,
    list: entry.list,
    active: entry.active,
    notifyRelease: entry.notify_release,
    canonOnly: entry.canon_only,
    cursorSeason: entry.cursor.season,
    cursorEpisode: entry.cursor.episode,
    positionSeconds: entry.cursor.position_seconds,
    seasons,
  };
}

export function normalizeBell(notification: BackendNotification): BellNotification {
  const payload = notification.payload;
  const findText = (...keys: string[]): string | undefined =>
    keys.map((key) => payload[key]).find((value): value is string => typeof value === "string");
  const timestamp = new Date(notification.created_at).getTime();

  return {
    id: `record:${notification.id}`,
    backendId: notification.id,
    origin: "record",
    source: null,
    media: notification.media,
    kind: notification.kind,
    creator: findText("channel", "anime", "title") ?? pretty(notification.media),
    title: findText("message", "video_title", "event_title", "title") ?? pretty(notification.kind),
    summary: findText("detail", "reason", "description") ?? "",
    time: relTime(notification.created_at),
    unread: !notification.seen,
    timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
  };
}

export function channelMode(
  kind: keyof typeof kindName | null,
): (typeof kindName)[keyof typeof kindName] | "Unknown" {
  return kind ? kindName[kind] : "Unknown";
}
