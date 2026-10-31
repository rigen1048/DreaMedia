import { CirclePlay } from "lucide-react";
import type { MediaNotification } from "../media";

type NotificationRowProps = {
  item: MediaNotification;
  onOpen: () => void;
};

export default function NotificationRow({ item, onOpen }: NotificationRowProps) {
  return (
    <button className={`signal-row ${item.unread ? "unread" : ""}`} onClick={onOpen}>
      <span className={`signal-indicator ${item.source === "ani" ? "signal-ani" : ""}`} />
      <span className={`signal-avatar signal-${item.color}`}>
        {item.creator.slice(0, 1).toUpperCase()}
      </span>
      <span className="signal-copy">
        <span className="signal-topline">
          <strong>{item.creator}</strong>
          <span>{item.time}</span>
        </span>
        <span className="signal-title">{item.title}</span>
        <span className="signal-bottomline">
          <span>
            {item.domain}
            <i>/</i>
            {item.subdomain}
          </span>
          <span className={`signal-mode mode-${item.mode.toLowerCase()}`}>{item.mode}</span>
        </span>
      </span>
      <CirclePlay className="signal-open" size={17} />
    </button>
  );
}
