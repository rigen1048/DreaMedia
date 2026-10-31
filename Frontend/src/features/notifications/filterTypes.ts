import type { MediaNotification, MediaSource } from "../media";
import type { CategoryBucket, FilterView, NotificationModeFilter } from "./constants";

export type NotificationFiltersProps = {
  source: MediaSource;
  filterView: FilterView;
  mode: NotificationModeFilter;
  search: string;
  unreadOnly: boolean;
  selectedDomain: string | null;
  selectedSubdomain: string | null;
  notifications: MediaNotification[];
  activeNotifications: MediaNotification[];
  categoryBuckets: CategoryBucket[];
  domains: string[];
  hasCategoryFilter: boolean;
  subdomainsForDomain: (domain: string) => CategoryBucket[];
  onSourceChange: (source: MediaSource) => void;
  onFilterViewChange: (view: FilterView) => void;
  onModeChange: (mode: NotificationModeFilter) => void;
  onSearchChange: (search: string) => void;
  onUnreadChange: (value: boolean) => void;
  onDomainChange: (domain: string | null) => void;
  onSubdomainChange: (subdomain: string | null) => void;
};

export type CategoryFiltersProps = Pick<
  NotificationFiltersProps,
  | "selectedDomain"
  | "selectedSubdomain"
  | "categoryBuckets"
  | "domains"
  | "subdomainsForDomain"
  | "onDomainChange"
  | "onSubdomainChange"
>;

export type NotificationSourceSearchProps = Pick<
  NotificationFiltersProps,
  "source" | "search" | "notifications" | "onSourceChange" | "onSearchChange"
>;

export type SubscriptionModeFiltersProps = Pick<
  NotificationFiltersProps,
  "mode" | "activeNotifications" | "onModeChange"
>;
