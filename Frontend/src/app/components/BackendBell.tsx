import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { useMedia } from "../../features/media";
import type { BellNotification } from "../../features/media";

type BackendBellProps = {
  closeToken: number;
  onOpen: () => void;
};

export default function BackendBell({ closeToken, onOpen }: BackendBellProps) {
  const [trayOpen, setTrayOpen] = useState(false);
  const { bellNotifications, markBellSeen } = useMedia();
  const unreadMessages = bellNotifications.filter((item) => item.unread);

  useEffect(() => setTrayOpen(false), [closeToken]);

  const closeTray = () => setTrayOpen(false);
  const acknowledgeMessage = async (item: BellNotification): Promise<void> => {
    if (item.unread) await markBellSeen([item]);
  };
  const acknowledgeAll = async (): Promise<void> => {
    if (unreadMessages.length) await markBellSeen(unreadMessages);
  };

  return (
    <div className="notification-anchor">
      <button
        className={`bell-button ${trayOpen ? "bell-open" : ""}`}
        aria-label={`Backend messages${unreadMessages.length ? `, ${unreadMessages.length} unseen` : ""}`}
        aria-expanded={trayOpen}
        onClick={() => {
          onOpen();
          setTrayOpen((open) => !open);
        }}
      >
        <Bell size={18} strokeWidth={1.8} />
        {unreadMessages.length > 0 && <span className="bell-count">{unreadMessages.length}</span>}
      </button>
      {trayOpen && (
        <div className="notification-tray compact-tray">
          <div className="tray-header">
            <strong>Messages</strong>
            <button
              className="icon-button small-icon"
              aria-label="Close messages"
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
                aria-label={`${item.unread ? "Acknowledge" : "Read"} backend message: ${item.title}`}
                onClick={() => void acknowledgeMessage(item)}
              >
                <span className="source-dot message-dot" />
                <span className="tray-copy">
                  <strong>{item.creator}</strong>
                  <span>{item.title}</span>
                  {item.summary && <span>{item.summary}</span>}
                  <small>
                    {item.media} · {item.kind} · {item.time}
                    {item.pushed ? " · delivered" : ""}
                  </small>
                </span>
                {item.unread && <span className="unread-dot" />}
              </button>
            ))}
            {bellNotifications.length === 0 && (
              <span className="tray-empty">No messages from the backend.</span>
            )}
          </div>
          <div className="tray-footer">
            <span>Backend msg · HTTP</span>
            <button
              className="tray-view-all"
              disabled={unreadMessages.length === 0}
              onClick={() => void acknowledgeAll()}
            >
              Mark all seen <span>{unreadMessages.length}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
