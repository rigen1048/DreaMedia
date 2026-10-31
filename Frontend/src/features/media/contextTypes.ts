import type { AniEntry, AniEntryPatch, SubscribeInput, YtChannel, YtKind } from "./api";
import type {
  AnimeTrack,
  AuthStatus,
  BellNotification,
  Category,
  ManagedChannel,
  ManagedDomain,
  MediaNotification,
  YoutubeTrack,
} from "./model/types";

export type MediaContextValue = {
  authStatus: AuthStatus;
  authError: string | null;
  syncError: string | null;
  username: string | null;
  refresh: () => Promise<void>;
  login: (name: string, password: string) => Promise<void>;
  signup: (name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  notifications: MediaNotification[];
  bellNotifications: BellNotification[];
  channels: ManagedChannel[];
  categories: Category[];
  domains: ManagedDomain[];
  youtubeTracks: YoutubeTrack[];
  anime: AnimeTrack[];
  subscribeYoutube: (
    input: SubscribeInput,
    category?: { domain: string; subdomain: string | null },
  ) => Promise<number>;
  switchChannelMode: (id: number, kind: YtKind, words?: string[], rank?: string) => Promise<void>;
  setChannelActive: (id: number, active: boolean) => Promise<void>;
  setChannelLabel: (id: number, label: YtChannel["label"], reason?: string) => Promise<void>;
  assignChannel: (id: number, domain: string, subdomain: string | null) => Promise<void>;
  deleteChannel: (id: number) => Promise<void>;
  markVideosSeen: (ids: number[], seen?: boolean) => Promise<void>;
  setCategoryActive: (domain: string, subdomain: string | null, active: boolean) => Promise<void>;
  createCategory: (domain: string, subdomain: string | null) => Promise<void>;
  renameCategory: (domain: string, newName: string, subdomain: string | null) => Promise<void>;
  deleteCategory: (domain: string, subdomain: string | null) => Promise<void>;
  markBellSeen: (items: BellNotification[], seen?: boolean) => Promise<void>;
  markFeedSeen: (items: MediaNotification[], seen?: boolean) => Promise<void>;
  trackAnime: (title: string, list: AniEntry["list"]) => Promise<void>;
  updateAnime: (id: number, patch: AniEntryPatch) => Promise<void>;
  setSeasonWatched: (id: number, seasonNo: number, watched: boolean) => Promise<void>;
  setAnimeCursor: (
    id: number,
    season: number,
    episode: number | null,
    seconds: number | null,
  ) => Promise<void>;
  markAnimeRange: (id: number, from: number, to: number) => Promise<void>;
  finishAnime: (entry: AnimeTrack) => Promise<void>;
  markAnimeEventsSeen: (ids: number[], seen?: boolean) => Promise<void>;
  deleteAnime: (id: number) => Promise<void>;
};
