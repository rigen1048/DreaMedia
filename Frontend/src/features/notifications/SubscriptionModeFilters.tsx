import { notificationModes } from "./constants";
import type { SubscriptionModeFiltersProps } from "./filterTypes";

export default function SubscriptionModeFilters({
  mode,
  activeNotifications,
  onModeChange,
}: SubscriptionModeFiltersProps) {
  return (
    <div className="subscription-filter-list">
      {notificationModes.map((item) => {
        const count =
          item === "All"
            ? activeNotifications.length
            : activeNotifications.filter((notice) => notice.mode === item).length;

        return (
          <button
            key={item}
            className={mode === item ? "active" : ""}
            onClick={() => onModeChange(item)}
          >
            {item}
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
