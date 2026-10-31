import type { NotificationMode } from "../media";

export const notificationModes: (NotificationMode | "All")[] = [
  "All",
  "Track",
  "Wordscan",
  "Playlist",
  "Random",
];

export type FilterView = "category" | "subscription";
export type NotificationModeFilter = NotificationMode | "All";

export type CategoryBucket = {
  domain: string;
  subdomain: string;
  count: number;
};
