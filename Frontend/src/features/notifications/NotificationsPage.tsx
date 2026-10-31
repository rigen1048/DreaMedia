import { useState } from "react";
import { useLocation } from "wouter";
import { useMedia, type MediaNotification } from "../media";
import NotificationFeed from "./NotificationFeed";
import NotificationFilters from "./NotificationFilters";
import { useNotificationFilters } from "./useNotificationFilters";

export default function NotificationsPage() {
  const [location, setLocation] = useLocation();
  const { notifications, channels, categories, markFeedSeen, refresh } = useMedia();
  const [error, setError] = useState("");
  const filters = useNotificationFilters({
    location,
    notifications,
    channels,
    categories,
  });

  const open = async (item: MediaNotification) => {
    setError("");
    try {
      if (item.unread) await markFeedSeen([item]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update seen state.");
      return;
    }
    const source = item.source === "youtube" ? "youtube" : "ani";
    setLocation(`/track?source=${source}&item=${encodeURIComponent(item.creator)}`);
  };
  const markVisible = async () => {
    setError("");
    try {
      await markFeedSeen(filters.unreadVisible);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update seen state.");
    }
  };

  return (
    <div className="page-content minimal-page notifications-page">
      <div className="minimal-heading">
        <div>
          <span className="page-kicker">MODE 01</span>
          <h1>Notifications</h1>
        </div>
        <div className="heading-metrics">
          <span>{filters.filtered.length} shown</span>
          <span className="metric-divider" />
          <span>{filters.activeNotifications.filter((item) => item.unread).length} unseen</span>
        </div>
      </div>
      <NotificationFilters
        source={filters.source}
        filterView={filters.filterView}
        mode={filters.mode}
        search={filters.search}
        unreadOnly={filters.unreadOnly}
        selectedDomain={filters.selectedDomain}
        selectedSubdomain={filters.selectedSubdomain}
        notifications={notifications}
        activeNotifications={filters.activeNotifications}
        categoryBuckets={filters.categoryBuckets}
        domains={filters.domains}
        hasCategoryFilter={filters.hasCategoryFilter}
        subdomainsForDomain={filters.subdomainsForDomain}
        onSourceChange={filters.chooseSource}
        onFilterViewChange={filters.setFilterView}
        onModeChange={filters.setMode}
        onSearchChange={filters.setSearch}
        onUnreadChange={filters.setUnreadOnly}
        onDomainChange={filters.chooseDomain}
        onSubdomainChange={filters.setSelectedSubdomain}
      />
      <NotificationFeed
        source={filters.source}
        filtered={filters.filtered}
        unreadVisible={filters.unreadVisible}
        error={error}
        onOpen={(item) => void open(item)}
        onRefresh={() => void refresh()}
        onMarkVisible={() => void markVisible()}
      />
    </div>
  );
}
