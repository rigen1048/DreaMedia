import { useEffect, useRef } from "react";
import { Search, Youtube } from "lucide-react";
import type { NotificationSourceSearchProps } from "./filterTypes";

export default function NotificationSourceSearch({
  source,
  search,
  notifications,
  onSourceChange,
  onSearchChange,
}: NotificationSourceSearchProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = () => {
      searchRef.current?.focus();
      window.setTimeout(() => {
        if (searchRef.current?.value === "/") onSearchChange("");
      }, 0);
    };

    window.addEventListener("dreamedia:focus-search", focusSearch);
    return () => window.removeEventListener("dreamedia:focus-search", focusSearch);
  }, [onSearchChange]);

  const youtubeCount = notifications.filter((item) => item.source === "youtube").length;
  const animeCount = notifications.filter((item) => item.source === "ani").length;

  return (
    <div className="notification-controls">
      <div className="source-switch" role="tablist" aria-label="Notification source">
        <button
          className={source === "youtube" ? "active" : ""}
          aria-selected={source === "youtube"}
          onClick={() => onSourceChange("youtube")}
        >
          <Youtube size={14} /> YouTube <span>{youtubeCount}</span>
        </button>
        <button
          className={source === "ani" ? "active" : ""}
          aria-selected={source === "ani"}
          onClick={() => onSourceChange("ani")}
        >
          <span className="ani-mark">あ</span> Ani <span>{animeCount}</span>
        </button>
      </div>
      <label className="minimal-search">
        <Search size={15} />
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search"
        />
        <kbd>/</kbd>
      </label>
    </div>
  );
}
