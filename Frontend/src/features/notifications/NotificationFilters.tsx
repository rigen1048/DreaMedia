import CategoryFilters from "./CategoryFilters";
import NotificationSourceSearch from "./NotificationSourceSearch";
import SubscriptionModeFilters from "./SubscriptionModeFilters";
import type { NotificationFiltersProps } from "./filterTypes";

export default function NotificationFilters(props: NotificationFiltersProps) {
  const {
    source,
    filterView,
    mode,
    unreadOnly,
    selectedDomain,
    selectedSubdomain,
    notifications,
    activeNotifications,
    categoryBuckets,
    domains,
    hasCategoryFilter,
    subdomainsForDomain,
    onSourceChange,
    onFilterViewChange,
    onModeChange,
    onSearchChange,
    onUnreadChange,
    onDomainChange,
    onSubdomainChange,
  } = props;

  return (
    <>
      <NotificationSourceSearch
        source={source}
        search={props.search}
        notifications={notifications}
        onSourceChange={onSourceChange}
        onSearchChange={onSearchChange}
      />
      {source === "youtube" && (
        <div className="filter-switch-row">
          <div className="filter-switch" aria-label="Filter type">
            <button
              className={filterView === "category" ? "active" : ""}
              onClick={() => onFilterViewChange("category")}
            >
              Domain / subdomain
            </button>
            <button
              className={filterView === "subscription" ? "active" : ""}
              onClick={() => onFilterViewChange("subscription")}
            >
              Subscription type
            </button>
          </div>
          <button
            className={`unread-filter ${unreadOnly ? "active" : ""}`}
            onClick={() => onUnreadChange(!unreadOnly)}
          >
            <span />
            Unseen
          </button>
        </div>
      )}
      {source === "youtube" && filterView === "category" && hasCategoryFilter && (
        <CategoryFilters
          selectedDomain={selectedDomain}
          selectedSubdomain={selectedSubdomain}
          domains={domains}
          categoryBuckets={categoryBuckets}
          subdomainsForDomain={subdomainsForDomain}
          onDomainChange={onDomainChange}
          onSubdomainChange={onSubdomainChange}
        />
      )}
      {source === "youtube" && filterView === "subscription" && (
        <SubscriptionModeFilters
          mode={mode}
          activeNotifications={activeNotifications}
          onModeChange={onModeChange}
        />
      )}
      {source === "youtube" &&
        filterView === "category" &&
        !hasCategoryFilter &&
        categoryBuckets.length === 1 && (
          <div className="single-category-label">
            <span>{categoryBuckets[0].domain}</span>
            <span>/</span>
            <strong>{categoryBuckets[0].subdomain}</strong>
          </div>
        )}
    </>
  );
}
