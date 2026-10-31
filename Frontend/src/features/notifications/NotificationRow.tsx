import { CirclePlay } from "lucide-react";
import type { MediaNotification } from "../media";

// YouTube-style row (D51): thumbnail + channel icon + title.
// The letter avatar only renders when there is no real channel logo.

type NotificationRowProps = {
  item: MediaNotification;
  onOpen: () => void;
};

export default function NotificationRow({ item, onOpen }: NotificationRowProps) {
  return (
    <button className={`signal-row ${item.unread ? "unread" : ""}`} onClick={onOpen}>
      <span className={`signal-indicator ${item.source === "ani" ? "signal-ani" : ""}`} />
      {item.thumbnail ? (
        <span
          className="signal-thumb"
          style={{ backgroundImage: `url("${item.thumbnail}")` }}
          aria-hidden="true"
        />
      ) : null}
      {item.channelLogo ? (
        <img className="signal-avatar signal-avatar-img" src={item.channelLogo} alt="" loading="lazy" />
      ) : (
        <span className={`signal-avatar signal-${item.color}`}>
          {item.creator.slice(0, 1).toUpperCase()}
        </span>
      )}
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
