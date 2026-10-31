import { api } from "../api";
import type { AniEntry, ApiDomain, BackendNotification } from "../api";
import type { FeedBundle } from "../api/graphqlFeed";

export type ManagementBundle = {
  entries: AniEntry[];
  categories: ApiDomain[];
};

export const emptyFeedBundle: FeedBundle = {
  videos: [],
  sidebar: [],
  channels: [],
  events: [],
};

export const emptyManagementBundle: ManagementBundle = {
  entries: [],
  categories: [],
};

export const fetchFeedBundle = (): Promise<FeedBundle> => api.feed.read();

export async function fetchManagementBundle(): Promise<ManagementBundle> {
  const [anime, categories] = await Promise.all([api.ani.management(), api.yt.categories()]);
  return {
    entries: anime.entries,
    categories: categories.domains,
  };
}

export async function fetchBackendMessages(): Promise<BackendNotification[]> {
  const response = await api.notifications.list();
  return response.notifications;
}
