import { api } from "../api";
import type {
  AniEntry,
  AniEvent,
  ApiDomain,
  BackendNotification,
  SidebarDomain,
  YtChannel,
  YtVideo,
} from "../api";

export type MediaBundle = {
  videos: YtVideo[];
  sidebar: SidebarDomain[];
  channels: YtChannel[];
  events: AniEvent[];
  entries: AniEntry[];
  categories: ApiDomain[];
  bell: BackendNotification[];
};

export const emptyMediaBundle: MediaBundle = {
  videos: [],
  sidebar: [],
  channels: [],
  events: [],
  entries: [],
  categories: [],
  bell: [],
};

export async function fetchMediaBundle(): Promise<MediaBundle> {
  const [feed, sidebar, channelList, eventFeed, animeList, categoryList, bell] = await Promise.all([
    api.yt.videos(),
    api.yt.sidebar(),
    api.yt.channels(true),
    api.ani.events(true),
    api.ani.management(),
    api.yt.categories(),
    api.notifications.list(),
  ]);

  return {
    videos: feed.videos,
    sidebar: sidebar.domains,
    channels: channelList.channels,
    events: eventFeed.events,
    entries: animeList.entries,
    categories: categoryList.domains,
    bell: bell.notifications,
  };
}
