import { useEffect, useMemo, useState } from "react";
import type { Category, ManagedChannel, MediaNotification, MediaSource } from "../media";
import type { CategoryBucket, FilterView, NotificationModeFilter } from "./constants";

type UseNotificationFiltersArgs = {
  location: string;
  notifications: MediaNotification[];
  channels: ManagedChannel[];
  categories: Category[];
};

export function useNotificationFilters({
  location,
  notifications,
  channels,
  categories,
}: UseNotificationFiltersArgs) {
  const [source, setSource] = useState<MediaSource>("youtube");
  const [filterView, setFilterView] = useState<FilterView>("category");
  const [mode, setMode] = useState<NotificationModeFilter>("All");
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(null);

  useEffect(() => {
    const querySource = new URLSearchParams(location.split("?")[1] ?? "").get("source");
    if (querySource === "ani" || querySource === "youtube") setSource(querySource);
  }, [location]);

  const sourceNotifications = useMemo(
    () => notifications.filter((item) => item.source === source),
    [notifications, source],
  );
  const activeNotifications = useMemo(() => {
    if (source !== "youtube") return sourceNotifications;
    return sourceNotifications.filter((item) => {
      const channel = channels.find(
        (entry) => entry.name.toLowerCase() === item.creator.toLowerCase(),
      );
      const category = categories.find(
        (entry) => entry.domain === item.domain && entry.subdomain === item.subdomain,
      );
      return (
        channel?.label !== "blocked" &&
        channel?.label !== "reserved" &&
        channel?.active !== false &&
        (!category || category.active)
      );
    });
  }, [categories, channels, source, sourceNotifications]);
  const categoryBuckets = useMemo(() => {
    const counts = new Map<string, CategoryBucket>();
    activeNotifications.forEach((item) => {
      const key = `${item.domain}::${item.subdomain}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else
        counts.set(key, {
          domain: item.domain,
          subdomain: item.subdomain,
          count: 1,
        });
    });
    return [...counts.values()];
  }, [activeNotifications]);
  const domains = [...new Set(categoryBuckets.map((item) => item.domain))];
  const filtered = activeNotifications.filter((item) => {
    if (
      source === "youtube" &&
      filterView === "subscription" &&
      mode !== "All" &&
      item.mode !== mode
    )
      return false;
    if (
      source === "youtube" &&
      filterView === "category" &&
      selectedDomain &&
      item.domain !== selectedDomain
    )
      return false;
    if (
      source === "youtube" &&
      filterView === "category" &&
      selectedSubdomain &&
      item.subdomain !== selectedSubdomain
    )
      return false;
    if (unreadOnly && !item.unread) return false;
    return (
      !search ||
      `${item.creator} ${item.title} ${item.domain} ${item.subdomain} ${item.mode}`
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });

  const chooseSource = (nextSource: MediaSource) => {
    setSource(nextSource);
    setSelectedDomain(null);
    setSelectedSubdomain(null);
  };
  const chooseFilterView = (nextView: FilterView) => {
    setFilterView(nextView);
    setSelectedDomain(null);
    setSelectedSubdomain(null);
  };
  const chooseDomain = (domain: string | null) => {
    setSelectedDomain(domain);
    setSelectedSubdomain(null);
  };

  return {
    source,
    filterView,
    mode,
    search,
    unreadOnly,
    selectedDomain,
    selectedSubdomain,
    setFilterView: chooseFilterView,
    setMode,
    setSearch,
    setUnreadOnly,
    setSelectedSubdomain,
    chooseSource,
    chooseDomain,
    sourceNotifications,
    activeNotifications,
    categoryBuckets,
    domains,
    filtered,
    unreadVisible: filtered.filter((item) => item.unread),
    hasCategoryFilter: source === "youtube" && categoryBuckets.length > 1,
    subdomainsForDomain: (domain: string) =>
      categoryBuckets.filter((item) => item.domain === domain),
  };
}
