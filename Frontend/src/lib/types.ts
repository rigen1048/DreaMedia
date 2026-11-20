export type Viewer = { id: number; username: string; role: string };

export type YtKind = "tracking" | "wordscan" | "playlist" | "random";

export type YtVideo = {
  id: number;
  channelId: number;
  title: string | null;
  url: string | null;
  thumbnail: string | null;
  publishedAt: number | null;
  seen: boolean;
  channel: string | null;
  channelLogo: string | null;
  mode: YtKind;
  notifyEnabled: boolean;
  label: string;
  domain: string;
  subdomain: string;
};

export type YtChannel = {
  id: number;
  name: string | null;
  url: string | null;
  logo: string | null;
  label: string;
  labelReason: string | null;
  rssId: string | null;
  kind: YtKind | null;
  active: boolean | null;
  rank: string | null;
  words: string[];
  domain: string;
  subdomain: string;
  domainId: number | null;
  subdomainId: number | null;
  notify: boolean;
  notifyEnabled: boolean;
};

export type Subdomain = {
  id: number;
  name: string;
  active: boolean;
  notify: boolean;
  channelCount: number;
  blockedCount: number;
};

export type Domain = {
  id: number;
  name: string;
  active: boolean;
  notify: boolean;
  channelCount: number;
  subdomains: Subdomain[];
};

export type CardItem = {
  id: number;
  videoId: string;
  url: string | null;
  title: string | null;
  thumbnail: string | null;
  done: boolean;
  addedAt: string;
};

export type PlaylistCard = {
  id: number;
  name: string | null;
  createdAt: string;
  total: number;
  done: number;
  items: CardItem[];
};

export type AniSeason = {
  seasonNo: number;
  title: string | null;
  poster: string | null;
  status: string | null;
  episodesTotal: number | null;
  episodesAired: number | null;
  state: string;
  watched: boolean;
  startDate: string | null;
  releaseDate: string | null;
  nextAiringAt: number | null;
  nextAiringEp: number | null;
};

export type AniList = "watching" | "up_to_date" | "next_sequel" | "new_anime" | "watchlist";
export type WatchState = "confirmed" | "maybe" | null;

export type AniEntry = {
  id: number;
  title: string | null;
  cover: string | null;
  label: string;
  labelReason: string | null;
  list: AniList;
  watchState: WatchState;
  active: boolean;
  notifyRelease: boolean;
  notifyEnabled: boolean;
  canonOnly: boolean;
  animeType: string | null;
  airingTime: string | null;
  domainId: number | null;
  subdomainId: number | null;
  domain: string;
  subdomain: string;
  cursorSeason: number | null;
  cursorEpisode: number | null;
  positionSeconds: number | null;
  totalSeasons: number;
  episodeCount: number;
  airedCount: number;
  watchedSeasons: number;
  releaseDate: string | null;
  nextAiringAt: number | null;
  nextAiringEp: number | null;
  seasons: AniSeason[];
};

export type AniEvent = {
  id: number;
  entryId: number;
  title: string | null;
  cover: string | null;
  animeType: string | null;
  seasonNo: number | null;
  kind: string;
  group: "release" | "change";
  bucket: "today" | "sequel" | "new";
  label: string;
  tier: string;
  seen: boolean;
  createdAt: string;
  payload: string;
  domain: string;
  subdomain: string;
  notifyEnabled: boolean;
};

export type Workspace = {
  viewer: Viewer | null;
  ytFeed: YtVideo[];
  ytChannels: YtChannel[];
  ytDomains: Domain[];
  ytUnassignedCount: number;
  ytCards: PlaylistCard[];
  aniEntries: AniEntry[];
  aniEvents: AniEvent[];
  aniDomains: Domain[];
};

export type BellMessage = {
  id: string;
  rowId: number | null;
  userId: number;
  media: "yt" | "ani" | string;
  kind: string;
  title: string;
  message: string;
  level: string;
  url: string | null;
  createdAt: string;
  payload?: Record<string, unknown>;
  seen: boolean;
};

export type YtTrashItem = {
  id: number;
  title: string | null;
  url: string | null;
  thumbnail: string | null;
  channel: string | null;
  publishedAt: number | null;
  trashedAt: number;
};

export type AniTrashItem = {
  id: number;
  entryId: number;
  seasonNo: number | null;
  kind: string;
  title: string | null;
  cover: string | null;
  payload: string;
  createdAt: string;
  trashedAt: number;
};
