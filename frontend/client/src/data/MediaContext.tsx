import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, BackendError, type AniEntry, type AniEvent, type AniSeason as ApiAniSeason, type SidebarDomain, type SubscribeInput, type YtChannel, type YtVideo } from "../lib/api";

export type MediaSource = "youtube" | "ani";
export type NotificationMode = "Track" | "Wordscan" | "Playlist" | "Random" | "Unknown";
export type AuthStatus = "loading" | "unauthenticated" | "ready" | "error";
export type MediaNotification = { id: string; source: MediaSource; mode: NotificationMode; creator: string; title: string; summary: string; domain: string; subdomain: string; time: string; unread: boolean; color: string; timestamp: number };
export type ManagedChannel = { id: number; name: string; url: string; mode: NotificationMode; kind: YtChannel["kind"]; rssId: string | null; domain: string; subdomain: string; label: YtChannel["label"]; note: string };
export type Category = { id: string; domain: string; subdomain: string; active: boolean };
export type VideoTodo = { id: string; title: string; channel: string; url: string; thumbnail: string; age: string; seen: boolean; color: string };
export type YoutubeTrack = { id: string; channelId: number; title: string; url: string; rssId: string | null; domain: string; subdomain: string; videos: VideoTodo[] };
export type AnimeSeason = { id: string; seasonNo: number; label: string; name: string; episodes: number; aired: number; watched: boolean; status: "Completed" | "Releasing" | "Planned"; state: ApiAniSeason["state"] };
export type AnimeTrack = { id: string; backendId: number; title: string; status: "Completed" | "Releasing" | "Watching" | "Planned"; list: AniEntry["list"]; active: boolean; notifyRelease: boolean; lastWatched: number | null; seasons: AnimeSeason[] };
type RawData = { videos: YtVideo[]; domains: SidebarDomain[]; channels: YtChannel[]; events: AniEvent[]; entries: AniEntry[] };
const emptyData: RawData = { videos: [], domains: [], channels: [], events: [], entries: [] };
const colors = ["lime", "violet", "blue", "orange", "gold"];
const kindName: Record<NonNullable<YtChannel["kind"]>, NotificationMode> = { tracking: "Track", wordscan: "Wordscan", playlist: "Playlist", random: "Random" };
const relTime = (input: number | string | null | undefined) => {
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
const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const normalizeSeason = (season: ApiAniSeason): AnimeSeason => ({ id: String(season.season_no), seasonNo: season.season_no, label: `Season ${season.season_no}`, name: `Season ${season.season_no}`, episodes: season.episodes_total ?? 0, aired: season.episodes_aired ?? 0, watched: season.watched, status: season.watched || season.state === "finished" ? "Completed" : season.state === "airing" || season.state === "announced" ? "Releasing" : "Planned", state: season.state });
const normalizeAnime = (entry: AniEntry): AnimeTrack => {
  const seasons = entry.seasons.map(normalizeSeason);
  const status = entry.label === "completed" || (seasons.length > 0 && seasons.every((season) => season.watched)) ? "Completed" : seasons.some((season) => season.status === "Releasing") ? "Releasing" : entry.list === "watching" ? "Watching" : "Planned";
  return { id: String(entry.id), backendId: entry.id, title: entry.title ?? "Untitled anime", status, list: entry.list, active: entry.active, notifyRelease: entry.notify_release, lastWatched: entry.last_watched_episode, seasons };
};

type AuthResult = { ok: true; user_id: number; username: string; role: string };
type ContextValue = {
  authStatus: AuthStatus; authError: string | null; syncError: string | null; username: string | null; refresh: () => Promise<void>; login: (name: string, password: string) => Promise<void>; signup: (name: string, password: string) => Promise<void>; logout: () => Promise<void>;
  notifications: MediaNotification[]; channels: ManagedChannel[]; categories: Category[]; youtubeTracks: YoutubeTrack[]; anime: AnimeTrack[];
  subscribeYoutube: (input: SubscribeInput, category?: { domain: string; subdomain: string | null }) => Promise<void>; setChannelLabel: (id: number, label: YtChannel["label"], reason?: string) => Promise<void>; assignChannel: (id: number, domain: string, subdomain: string | null) => Promise<void>; deleteChannel: (id: number) => Promise<void>; setCategoryActive: (domain: string, subdomain: string | null, active: boolean) => Promise<void>;
  trackAnime: (title: string, list: AniEntry["list"]) => Promise<void>; updateAnime: (id: number, patch: Parameters<typeof api.ani.updateEntry>[1]) => Promise<void>; setSeasonWatched: (id: number, seasonNo: number, watched: boolean) => Promise<void>; finishAnime: (entry: AnimeTrack) => Promise<void>; deleteAnime: (id: number) => Promise<void>;
};
const MediaContext = createContext<ContextValue | null>(null);

export function MediaProvider({ children }: { children: ReactNode }) {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [authError, setAuthError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [raw, setRaw] = useState<RawData>(emptyData);

  const refresh = useCallback(async () => {
    try {
      const [feed, sidebar, channelList, eventFeed, animeList] = await Promise.all([api.yt.videos(), api.yt.sidebar(), api.yt.channels(true), api.ani.events(true), api.ani.management()]);
      setRaw({ videos: feed.videos, domains: sidebar.domains, channels: channelList.channels, events: eventFeed.events, entries: animeList.entries });
      setAuthStatus("ready"); setAuthError(null); setSyncError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backend request failed.";
      if (error instanceof BackendError && error.status === 401) { setAuthStatus("unauthenticated"); setUsername(null); setAuthError(null); return; }
      setAuthStatus((current) => current === "ready" ? "ready" : "error"); setAuthError(message); setSyncError(message);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (authStatus !== "ready") return; const timer = window.setInterval(() => void refresh(), 30_000); return () => window.clearInterval(timer); }, [authStatus, refresh]);
  const finishLogin = useCallback(async (result: AuthResult) => { setUsername(result.username); setAuthStatus("loading"); await refresh(); }, [refresh]);
  const login = useCallback(async (name: string, password: string) => finishLogin(await api.auth.login(name, password)), [finishLogin]);
  const signup = useCallback(async (name: string, password: string) => finishLogin(await api.auth.signup(name, password)), [finishLogin]);
  const logout = useCallback(async () => { try { await api.auth.logout(); } finally { setRaw(emptyData); setUsername(null); setAuthStatus("unauthenticated"); } }, []);
  const after = useCallback(async (operation: () => Promise<unknown>) => { await operation(); await refresh(); }, [refresh]);
  const channels = useMemo(() => raw.channels.map((channel) => ({ id: channel.id, name: channel.name ?? "Untitled channel", url: channel.url ?? "", mode: channel.kind ? kindName[channel.kind] : "Unknown" as const, kind: channel.kind, rssId: channel.rss_id, domain: channel.domain, subdomain: channel.subdomain, label: channel.label, note: channel.label_reason ?? "" })), [raw.channels]);
  const categories = useMemo<Category[]>(() => raw.domains.flatMap((domain) => domain.subdomains.map((sub) => ({ id: `${domain.name}::${sub.name}`, domain: domain.name, subdomain: sub.name, active: domain.active && sub.active }))), [raw.domains]);
  const youtubeTracks = useMemo<YoutubeTrack[]>(() => channels.filter((channel) => channel.label === "none").map((channel) => ({ id: String(channel.id), channelId: channel.id, title: channel.name, url: channel.url, rssId: channel.rssId, domain: channel.domain, subdomain: channel.subdomain, videos: raw.videos.filter((video) => video.channel === channel.name).map((video, index) => ({ id: `${video.url ?? video.title ?? "video"}:${video.published_at ?? index}`, title: video.title ?? "Untitled video", channel: video.channel ?? channel.name, url: video.url ?? "", thumbnail: video.thumbnail ?? "", age: relTime(video.published_at), seen: video.seen, color: colors[index % colors.length] })) })), [channels, raw.videos]);
  const anime = useMemo(() => raw.entries.map(normalizeAnime), [raw.entries]);
  const notifications = useMemo<MediaNotification[]>(() => {
    const channelByName = new Map(channels.map((channel) => [channel.name.toLowerCase(), channel]));
    const yt = raw.videos.map((video, index) => {
      const channel = channelByName.get((video.channel ?? "").toLowerCase()); const stamp = video.published_at ?? 0;
      return { id: `youtube:${video.url ?? `${video.title}:${stamp}:${index}`}`, source: "youtube" as const, mode: channel?.mode ?? "Unknown" as const, creator: video.channel ?? "YouTube", title: video.title ?? "Untitled video", summary: video.url ?? "", domain: channel?.domain ?? "Unsorted", subdomain: channel?.subdomain ?? "Unsorted", time: relTime(stamp), unread: !video.seen, color: colors[index % colors.length], timestamp: stamp };
    });
    const ani = raw.events.map((event, index) => { const timestamp = new Date(event.created_at).getTime(); const payloadTitle = typeof event.payload.title === "string" ? event.payload.title : pretty(event.kind); return { id: `ani:${event.id}`, source: "ani" as const, mode: "Unknown" as const, creator: "Ani update", title: payloadTitle, summary: pretty(event.kind), domain: "Anime", subdomain: pretty(event.kind), time: relTime(event.created_at), unread: !event.seen, color: colors[index % colors.length], timestamp: Number.isNaN(timestamp) ? 0 : timestamp }; });
    return [...yt, ...ani].sort((a, b) => b.timestamp - a.timestamp);
  }, [raw.videos, raw.events, channels]);
  const value = useMemo<ContextValue>(() => ({
    authStatus, authError, syncError, username, refresh, login, signup, logout, notifications, channels, categories, youtubeTracks, anime,
    subscribeYoutube: async (input, category) => { const result = await api.yt.subscribe(input); if (category?.domain) await api.yt.assignChannel(result.channel_id, category.domain, category.subdomain); await refresh(); },
    setChannelLabel: (id, label, reason) => after(() => api.yt.setChannelLabel(id, label, reason)),
    assignChannel: (id, domain, subdomain) => after(() => api.yt.assignChannel(id, domain, subdomain)),
    deleteChannel: (id) => after(() => api.yt.deleteChannel(id)),
    setCategoryActive: (domain, subdomain, active) => after(() => api.yt.setCategoryActive(domain, subdomain, active)),
    trackAnime: (title, list) => after(() => api.ani.track(title, list)),
    updateAnime: (id, patch) => after(() => api.ani.updateEntry(id, patch)),
    setSeasonWatched: (id, seasonNo, watched) => after(() => api.ani.setSeasonWatched(id, seasonNo, watched)),
    finishAnime: async (entry) => { await Promise.all(entry.seasons.map((season) => api.ani.setSeasonWatched(entry.backendId, season.seasonNo, true))); const watched = entry.seasons.reduce((sum, season) => sum + season.episodes, 0); await api.ani.updateEntry(entry.backendId, { last_watched_episode: watched }); await refresh(); },
    deleteAnime: (id) => after(() => api.ani.deleteEntry(id)),
  }), [authStatus, authError, syncError, username, refresh, login, signup, logout, notifications, channels, categories, youtubeTracks, anime, after]);
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}
export function useMedia() { const value = useContext(MediaContext); if (!value) throw new Error("useMedia must be used inside MediaProvider"); return value; }
