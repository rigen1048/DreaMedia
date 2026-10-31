import type { MediaNotification, MediaSource } from "../media";
import NotificationRow from "./NotificationRow";

type NotificationFeedProps = {
  source: MediaSource;
  filtered: MediaNotification[];
  unreadVisible: MediaNotification[];
  error: string;
  onOpen: (item: MediaNotification) => void;
  onRefresh: () => void;
  onMarkVisible: () => void;
};

export default function NotificationFeed({
  source,
  filtered,
  unreadVisible,
  error,
  onOpen,
  onRefresh,
  onMarkVisible,
}: NotificationFeedProps) {
  return (
    <>
      {error && (
        <div className="inline-api-error" role="alert">
          {error}
        </div>
      )}
      <div className="signal-list-header">
        <span>{source === "youtube" ? "RECENT" : "ANI EVENTS"}</span>
        <div>
          <button onClick={onRefresh}>Refresh</button>
          {unreadVisible.length > 0 && (
            <button onClick={onMarkVisible}>Mark visible seen · {unreadVisible.length}</button>
          )}
        </div>
      </div>
      <div className="signal-list">
        {filtered.length ? (
          filtered.map((item) => (
            <NotificationRow key={item.id} item={item} onOpen={() => onOpen(item)} />
          ))
        ) : (
          <div className="minimal-empty">No backend items match.</div>
        )}
      </div>
      <div className="keyboard-hint">
        <span>
          <kbd>1</kbd> Notifications
        </span>
        <span>
          <kbd>2</kbd> Management
        </span>
        <span>
          <kbd>3</kbd> Todo
        </span>
        <button onClick={onRefresh}>Refresh</button>
      </div>
    </>
  );
}
