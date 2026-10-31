import type { AniEntry, AniSeason as ApiAniSeason, YtChannel, YtKind } from "../api";

export type MediaSource = "youtube" | "ani";
export type NotificationMode = "Track" | "Wordscan" | "Playlist" | "Random" | "Unknown";
export type AuthStatus = "loading" | "unauthenticated" | "ready" | "error";

export type MediaNotification = {
  id: string;
  backendId: number;
  source: MediaSource;
  mode: NotificationMode;
  creator: string;
  channelLogo: string;
  thumbnail: string;
  title: string;
  summary: string;
  domain: string;
  subdomain: string;
  time: string;
  unread: boolean;
  color: string;
  timestamp: number;
};

export type BellNotification = {
  id: string;
  backendId: number;
  source: MediaSource | null;
  media: string;
  kind: string;
  creator: string;
  title: string;
  summary: string;
  time: string;
  unread: boolean;
  pushed: boolean;
  timestamp: number;
};

export type ManagedChannel = {
  id: number;
  name: string;
  url: string;
  logo: string;
  mode: NotificationMode;
  kind: YtKind | null;
  active: boolean | null;
  rank: string | null;
  words: string[];
  rssId: string | null;
  domain: string;
  subdomain: string;
  label: YtChannel["label"];
  note: string;
};

export type Category = {
  id: string;
  domain: string;
  subdomain: string;
  active: boolean;
  domainId: number;
  subdomainId: number;
};

export type ManagedDomain = {
  id: number;
  name: string;
  active: boolean;
  subdomains: {
    id: number;
    name: string;
    active: boolean;
  }[];
};

export type VideoTodo = {
  id: number;
  title: string;
  channel: string;
  url: string;
  thumbnail: string;
  age: string;
  seen: boolean;
  color: string;
};

export type YoutubeTrack = {
  id: string;
  channelId: number;
  title: string;
  url: string;
  rssId: string | null;
  domain: string;
  subdomain: string;
  videos: VideoTodo[];
};

export type AnimeSeason = {
  id: string;
  seasonNo: number;
  label: string;
  name: string;
  episodes: number;
  aired: number;
  watched: boolean;
  status: "Completed" | "Releasing" | "Planned";
  state: ApiAniSeason["state"];
  startDate: string | null;
  releaseDate: string | null;
};

export type AnimeTrack = {
  id: string;
  backendId: number;
  title: string;
  cover: string;
  status: "Completed" | "Releasing" | "Watching" | "Planned";
  list: AniEntry["list"];
  active: boolean;
  notifyRelease: boolean;
  canonOnly: boolean;
  cursorSeason: number | null;
  cursorEpisode: number | null;
  positionSeconds: number | null;
  seasons: AnimeSeason[];
};
