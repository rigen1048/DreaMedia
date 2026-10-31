import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, BackendError, type AniEntry, type AniSeason as ApiAniSeason, type BackendNotification, type SubscribeInput, type YtChannel, type YtKind } from "../lib/api";
import { fetchMediaBundle, mediaQueryKeys, type MediaBundle } from "../lib/mediaQueries";

export type MediaSource = "youtube" | "ani";
export type NotificationMode = "Track" | "Wordscan" | "Playlist" | "Random" | "Unknown";
export type AuthStatus = "loading" | "unauthenticated" | "ready" | "error";
export type MediaNotification = { id: string; backendId: number; source: MediaSource; mode: NotificationMode; creator: string; title: string; summary: string; domain: string; subdomain: string; time: string; unread: boolean; color: string; timestamp: number };
export type BellNotification = { id: string; backendId: number; origin: "record" | "feed"; source: MediaSource | null; media: string; kind: string; creator: string; title: string; summary: string; time: string; unread: boolean; timestamp: number };
export type ManagedChannel = { id: number; name: string; url: string; mode: NotificationMode; kind: YtKind | null; active: boolean | null; rank: string | null; words: string[]; rssId: string | null; domain: string; subdomain: string; label: YtChannel["label"]; note: string };
export type Category = { id: string; domain: string; subdomain: string; active: boolean; domainId: number; subdomainId: number };
export type ManagedDomain = { id: number; name: string; active: boolean; subdomains: { id: number; name: string; active: boolean }[] };
export type VideoTodo = { id: number; title: string; channel: string; url: string; thumbnail: string; age: string; seen: boolean; color: string };
export type YoutubeTrack = { id: string; channelId: number; title: string; url: string; rssId: string | null; domain: string; subdomain: string; videos: VideoTodo[] };
export type AnimeSeason = { id: string; seasonNo: number; label: string; name: string; episodes: number; aired: number; watched: boolean; status: "Completed" | "Releasing" | "Planned"; state: ApiAniSeason["state"]; startDate: string | null; releaseDate: string | null };
export type AnimeTrack = { id: string; backendId: number; title: string; cover: string; status: "Completed" | "Releasing" | "Watching" | "Planned"; list: AniEntry["list"]; active: boolean; notifyRelease: boolean; canonOnly: boolean; cursorSeason: number | null; cursorEpisode: number | null; positionSeconds: number | null; seasons: AnimeSeason[] };

const emptyBundle: MediaBundle = { videos: [], sidebar: [], channels: [], events: [], entries: [], categories: [], bell: [] };
const colors = ["lime", "violet", "blue", "orange", "gold"];
const kindName: Record<NonNullable<YtChannel["kind"]>, NotificationMode> = { tracking: "Track", wordscan: "Wordscan", playlist: "Playlist", random: "Random" };
const relTime = (input: number | string | null | undefined): string => {
  if (!input) return "—";
  const date = typeof input === "number" ? new Date(input < 10_000_000_000 ? input * 1000 : input) : new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : date.toLocaleDateString();
};
const pretty = (value: string): string => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const normalizeSeason = (season: ApiAniSeason): AnimeSeason => ({ id: String(season.season_no), seasonNo: season.season_no, label: `Season ${season.season_no}`, name: season.title ?? `Season ${season.season_no}`, episodes: season.episodes_total ?? 0, aired: season.episodes_aired ?? 0, watched: season.watched, status: season.watched || season.state === "finished" ? "Completed" : season.state === "airing" || season.state === "announced" ? "Releasing" : "Planned", state: season.state, startDate: season.start_date, releaseDate: season.release_date });
const normalizeAnime = (entry: AniEntry): AnimeTrack => {
  const seasons = entry.seasons.map(normalizeSeason);
  const status = entry.label === "completed" || (seasons.length > 0 && seasons.every((season) => season.watched)) ? "Completed" : seasons.some((season) => season.status === "Releasing") ? "Releasing" : entry.list === "watching" ? "Watching" : "Planned";
  return { id: String(entry.id), backendId: entry.id, title: entry.title ?? "Untitled anime", cover: entry.cover ?? "", status, list: entry.list, active: entry.active, notifyRelease: entry.notify_release, canonOnly: entry.canon_only, cursorSeason: entry.cursor.season, cursorEpisode: entry.cursor.episode, positionSeconds: entry.cursor.position_seconds, seasons };
};
const normalizeBell = (notification: BackendNotification): BellNotification => {
  const payload = notification.payload;
  const findText = (...keys: string[]): string | undefined => keys.map((key) => payload[key]).find((value): value is string => typeof value === "string");
  const timestamp = new Date(notification.created_at).getTime();
  return { id: `record:${notification.id}`, backendId: notification.id, origin: "record", source: null, media: notification.media, kind: notification.kind, creator: findText("channel", "anime", "title") ?? pretty(notification.media), title: findText("message", "video_title", "event_title", "title") ?? pretty(notification.kind), summary: findText("detail", "reason", "description") ?? "", time: relTime(notification.created_at), unread: !notification.seen, timestamp: Number.isNaN(timestamp) ? 0 : timestamp };
};
const asMessage = (error: unknown): string => error instanceof Error ? error.message : "Backend request failed.";

type AuthResult = { ok: true; user_id: number; username: string; role: string };
type ContextValue = {
  authStatus: AuthStatus; authError: string | null; syncError: string | null; username: string | null; refresh: () => Promise<void>; login: (name: string, password: string) => Promise<void>; signup: (name: string, password: string) => Promise<void>; logout: () => Promise<void>;
  notifications: MediaNotification[]; bellNotifications: BellNotification[]; channels: ManagedChannel[]; categories: Category[]; domains: ManagedDomain[]; youtubeTracks: YoutubeTrack[]; anime: AnimeTrack[];
  subscribeYoutube: (input: SubscribeInput, category?: { domain: string; subdomain: string | null }) => Promise<number>; switchChannelMode: (id: number, kind: YtKind, words?: string[], rank?: string) => Promise<void>; setChannelActive: (id: number, active: boolean) => Promise<void>; setChannelLabel: (id: number, label: YtChannel["label"], reason?: string) => Promise<void>; assignChannel: (id: number, domain: string, subdomain: string | null) => Promise<void>; deleteChannel: (id: number) => Promise<void>; markVideosSeen: (ids: number[], seen?: boolean) => Promise<void>; setCategoryActive: (domain: string, subdomain: string | null, active: boolean) => Promise<void>; createCategory: (domain: string, subdomain: string | null) => Promise<void>; renameCategory: (domain: string, newName: string, subdomain: string | null) => Promise<void>; deleteCategory: (domain: string, subdomain: string | null) => Promise<void>;
  markNotificationSeen: (ids: number[], seen?: boolean) => Promise<void>; markBellSeen: (items: BellNotification[], seen?: boolean) => Promise<void>; markFeedSeen: (items: MediaNotification[], seen?: boolean) => Promise<void>;
  trackAnime: (title: string, list: AniEntry["list"]) => Promise<void>; updateAnime: (id: number, patch: Parameters<typeof api.ani.updateEntry>[1]) => Promise<void>; setSeasonWatched: (id: number, seasonNo: number, watched: boolean) => Promise<void>; setAnimeCursor: (id: number, season: number, episode: number | null, seconds: number | null) => Promise<void>; markAnimeRange: (id: number, from: number, to: number) => Promise<void>; finishAnime: (entry: AnimeTrack) => Promise<void>; markAnimeEventsSeen: (ids: number[], seen?: boolean) => Promise<void>; deleteAnime: (id: number) => Promise<void>;
};
const MediaContext = createContext<ContextValue | null>(null);

export function MediaProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: mediaQueryKeys.all, queryFn: fetchMediaBundle, refetchInterval: 30_000 });
  const raw = query.data ?? emptyBundle;
  const authenticationError = query.error instanceof BackendError && query.error.status === 401;
  const authStatus: AuthStatus = query.isLoading ? "loading" : authenticationError ? "unauthenticated" : query.isError ? "error" : "ready";
  const refresh = useCallback(async () => { await query.refetch(); }, [query]);
  const invalidate = useCallback(async () => { await queryClient.invalidateQueries({ queryKey: mediaQueryKeys.all }); await query.refetch(); }, [query, queryClient]);
  const finishLogin = useCallback(async (_result: AuthResult) => { await invalidate(); }, [invalidate]);
  const login = useCallback(async (name: string, password: string) => finishLogin(await api.auth.login(name, password)), [finishLogin]);
  const signup = useCallback(async (name: string, password: string) => finishLogin(await api.auth.signup(name, password)), [finishLogin]);
  const logout = useCallback(async () => { try { await api.auth.logout(); } finally { queryClient.setQueryData(mediaQueryKeys.all, emptyBundle); queryClient.removeQueries({ queryKey: mediaQueryKeys.all }); } }, [queryClient]);
  const after = useCallback(async (operation: () => Promise<unknown>) => { await operation(); await invalidate(); }, [invalidate]);
  const username = null;
  const channels = useMemo<ManagedChannel[]>(() => raw.channels.map((channel) => ({ id: channel.id, name: channel.name ?? "Untitled channel", url: channel.url ?? "", mode: channel.kind ? kindName[channel.kind] : "Unknown", kind: channel.kind, active: channel.label === "reserved" ? false : channel.active, rank: channel.rank, words: channel.words, rssId: channel.rss_id, domain: channel.domain, subdomain: channel.subdomain, label: channel.label, note: channel.label_reason ?? "" })), [raw.channels]);
  const domains = useMemo<ManagedDomain[]>(() => raw.categories.map((domain) => ({ id: domain.id, name: domain.name, active: domain.active, subdomains: domain.subdomains })), [raw.categories]);
  const categories = useMemo<Category[]>(() => raw.categories.flatMap((domain) => domain.subdomains.map((subdomain) => ({ id: `${domain.id}:${subdomain.id}`, domain: domain.name, subdomain: subdomain.name, active: domain.active && subdomain.active, domainId: domain.id, subdomainId: subdomain.id }))), [raw.categories]);
  const anime = useMemo<AnimeTrack[]>(() => raw.entries.map(normalizeAnime), [raw.entries]);
  const youtubeTracks = useMemo<YoutubeTrack[]>(() => channels.filter((channel) => channel.label === "none" && channel.active !== false).map((channel) => ({ id: String(channel.id), channelId: channel.id, title: channel.name, url: channel.url, rssId: channel.rssId, domain: channel.domain, subdomain: channel.subdomain, videos: raw.videos.filter((video) => video.channel_id === channel.id).map((video, index) => ({ id: video.id, title: video.title ?? "Untitled video", channel: video.channel ?? channel.name, url: video.url ?? "", thumbnail: video.thumbnail ?? "", age: relTime(video.published_at), seen: video.seen, color: colors[index % colors.length] })) })), [channels, raw.videos]);
  const notifications = useMemo<MediaNotification[]>(() => {
    const byChannel = new Map(channels.map((channel) => [channel.id, channel]));
    const youtube = raw.videos.map((video, index) => { const channel = byChannel.get(video.channel_id); const stamp = video.published_at ?? 0; return { id: `youtube:${video.id}`, backendId: video.id, source: "youtube" as const, mode: channel?.mode ?? "Unknown", creator: video.channel ?? channel?.name ?? "YouTube", title: video.title ?? "Untitled video", summary: video.url ?? "", domain: channel?.domain ?? "Unsorted", subdomain: channel?.subdomain ?? "Unsorted", time: relTime(stamp), unread: !video.seen, color: colors[index % colors.length], timestamp: stamp }; });
    const byEntry = new Map(anime.map((entry) => [entry.backendId, entry]));
    const ani = raw.events.map((event, index) => { const timestamp = new Date(event.created_at).getTime(); const title = typeof event.payload.title === "string" ? event.payload.title : pretty(event.kind); return { id: `ani:${event.id}`, backendId: event.id, source: "ani" as const, mode: "Unknown" as const, creator: byEntry.get(event.entry_id)?.title ?? "Ani update", title, summary: `${pretty(event.kind)} · ${pretty(event.tier)}`, domain: "Anime", subdomain: event.season_no ? `Season ${event.season_no}` : "Anime", time: relTime(event.created_at), unread: !event.seen, color: colors[index % colors.length], timestamp: Number.isNaN(timestamp) ? 0 : timestamp }; });
    return [...youtube, ...ani].sort((left, right) => right.timestamp - left.timestamp);
  }, [anime, channels, raw.events, raw.videos]);
  const bellNotifications = useMemo<BellNotification[]>(() => [...raw.bell.map(normalizeBell), ...notifications.map((item) => ({ id: `feed:${item.id}`, backendId: item.backendId, origin: "feed" as const, source: item.source, media: item.source, kind: item.mode, creator: item.creator, title: item.title, summary: item.summary, time: item.time, unread: item.unread, timestamp: item.timestamp }))].sort((left, right) => right.timestamp - left.timestamp).slice(0, 30), [notifications, raw.bell]);
  const value = useMemo<ContextValue>(() => ({
    authStatus, authError: authenticationError ? null : query.isError ? asMessage(query.error) : null, syncError: authStatus === "ready" && query.isError ? asMessage(query.error) : null, username, refresh, login, signup, logout, notifications, bellNotifications, channels, categories, domains, youtubeTracks, anime,
    subscribeYoutube: async (input, category) => { const result = await api.yt.subscribe(input); if (category?.domain) await api.yt.assignChannel(result.channel_id, category.domain, category.subdomain); await invalidate(); return result.channel_id; },
    switchChannelMode: (id, kind, words, rank) => after(() => api.yt.switchMode(id, kind, words, rank)), setChannelActive: (id, active) => after(() => api.yt.setChannelActive(id, active)), setChannelLabel: (id, label, reason) => after(() => api.yt.setChannelLabel(id, label, reason)), assignChannel: (id, domain, subdomain) => after(() => api.yt.assignChannel(id, domain, subdomain)), deleteChannel: (id) => after(() => api.yt.deleteChannel(id)), markVideosSeen: (ids, seen = true) => after(() => api.yt.markVideosSeen(ids, seen)), setCategoryActive: (domain, subdomain, active) => after(() => api.yt.setCategoryActive(domain, subdomain, active)), createCategory: (domain, subdomain) => after(() => api.yt.createCategory(domain, subdomain)), renameCategory: (domain, newName, subdomain) => after(() => api.yt.renameCategory(domain, newName, subdomain)), deleteCategory: (domain, subdomain) => after(() => api.yt.deleteCategory(domain, subdomain)), markNotificationSeen: (ids, seen = true) => after(() => api.notifications.markSeen(ids, seen)),
    markBellSeen: (items, seen = true) => after(() => Promise.all([api.notifications.markSeen(items.filter((item) => item.origin === "record").map((item) => item.backendId), seen), api.yt.markVideosSeen(items.filter((item) => item.origin === "feed" && item.source === "youtube").map((item) => item.backendId), seen), api.ani.markEventsSeen(items.filter((item) => item.origin === "feed" && item.source === "ani").map((item) => item.backendId), seen)])),
    markFeedSeen: (items, seen = true) => after(() => Promise.all([api.yt.markVideosSeen(items.filter((item) => item.source === "youtube").map((item) => item.backendId), seen), api.ani.markEventsSeen(items.filter((item) => item.source === "ani").map((item) => item.backendId), seen)])),
    markAnimeEventsSeen: (ids, seen = true) => after(() => api.ani.markEventsSeen(ids, seen)), trackAnime: (title, list) => after(() => api.ani.track(title, list)), updateAnime: (id, patch) => after(() => api.ani.updateEntry(id, patch)), setSeasonWatched: (id, seasonNo, watched) => after(() => api.ani.setSeasonWatched(id, seasonNo, watched)), setAnimeCursor: (id, season, episode, seconds) => after(() => api.ani.setCursor(id, season, episode, seconds)), markAnimeRange: (id, from, to) => after(() => api.ani.markRange(id, from, to)), finishAnime: (entry) => after(() => api.ani.markAllWatched(entry.backendId)), deleteAnime: (id) => after(() => api.ani.deleteEntry(id)),
  }), [after, anime, authStatus, authenticationError, bellNotifications, categories, channels, domains, invalidate, login, logout, notifications, query.error, query.isError, refresh, signup, username, youtubeTracks]);
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}
export function useMedia(): ContextValue { const value = useContext(MediaContext); if (!value) throw new Error("useMedia must be used inside MediaProvider"); return value; }
