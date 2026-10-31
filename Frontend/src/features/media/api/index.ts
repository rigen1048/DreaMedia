import { aniApi } from "./ani";
import { authApi } from "./auth";
import { graphqlFeedApi } from "./graphqlFeed";
import { notificationHistoryApi } from "./notificationHistory";
import { youtubeApi } from "./youtube";

export const api = {
  auth: authApi,
  feed: graphqlFeedApi,
  notifications: notificationHistoryApi,
  yt: youtubeApi,
  ani: aniApi,
} as const;

export { aniApi } from "./ani";
export { authApi } from "./auth";
export { graphqlFeedApi } from "./graphqlFeed";
export { notificationHistoryApi } from "./notificationHistory";
export { youtubeApi } from "./youtube";
export type { AniCursor, AniEntry, AniEntryPatch, AniEvent, AniSeason } from "./ani";
export type { AuthResult } from "./auth";
export type { FeedBundle } from "./graphqlFeed";
export type { BackendNotification, NotificationListResponse } from "./notificationHistory";
export type {
  ApiDomain,
  SidebarDomain,
  SubscribeInput,
  YtChannel,
  YtKind,
  YtVideo,
} from "./youtube";
