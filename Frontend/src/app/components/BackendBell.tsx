import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { useMedia, type BellNotification } from "../../features/media";

type BackendBellProps = {
  onNavigate: (href: string) => void;
  closeToken: number;
  onOpen: () => void;
};

export default function BackendBell({ onNavigate, closeToken, onOpen }: BackendBellProps) {
  const [trayOpen, setTrayOpen] = useState(false);
  const { bellNotifications, markBellSeen } = useMedia();
  const unreadCount = bellNotifications.filter((item) => item.unread).length;

  useEffect(() => setTrayOpen(false), [closeToken]);

  const closeTray = () => setTrayOpen(false);
  const openNotification = async (item: BellNotification) => {
    closeTray();
    if (item.unread) await markBellSeen([item]);
    if (item.origin === "record") {
      onNavigate("/notifications");
      return;
    }
    const source = item.source === "youtube" ? "youtube" : "ani";
    onNavigate(`/track?source=${source}&item=${encodeURIComponent(item.creator)}`);
  };

  return (
    <div className="notification-anchor">
      <button
        className={`bell-button ${trayOpen ? "bell-open" : ""}`}
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unseen` : ""}`}
        aria-expanded={trayOpen}
        onClick={() => {
          onOpen();
          setTrayOpen((open) => !open);
        }}
      >
        <Bell size={18} strokeWidth={1.8} />
        {unreadCount > 0 && <span className="bell-count">{unreadCount}</span>}
      </button>
      {trayOpen && (
        <div className="notification-tray compact-tray">
          <div className="tray-header">
            <strong>Recent</strong>
            <button
              className="icon-button small-icon"
              aria-label="Close notifications"
              onClick={closeTray}
            >
              <X size={15} />
            </button>
          </div>
          <div className="tray-list">
            {bellNotifications.slice(0, 5).map((item) => (
              <button
                key={item.id}
                className={`tray-item ${item.unread ? "is-unread" : ""}`}
                onClick={() => void openNotification(item)}
              >
                <span className={`source-dot ${item.source === "ani" ? "ani-dot" : "yt-dot"}`} />
                <span className="tray-copy">
                  <strong>{item.creator}</strong>
                  <span>{item.title}</span>
                  <small>{item.time}</small>
                </span>
                {item.unread && <span className="unread-dot" />}
              </button>
            ))}
            {bellNotifications.length === 0 && (
              <span className="tray-empty">No notifications from the backend.</span>
            )}
          </div>
          <div className="tray-footer">
            <span>Synced from backend</span>
            <button
              className="tray-view-all"
              onClick={() => {
                closeTray();
                onNavigate("/notifications");
              }}
            >
              Inbox <span>{unreadCount}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
