import { Search, Youtube } from "lucide-react";
import type { MediaSource } from "../media";

type TodoHeaderProps = {
  source: MediaSource;
  youtubeCount: number;
  animeCount: number;
  searchRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  onSourceChange: (source: MediaSource) => void;
};

export function TodoHeader({
  source,
  youtubeCount,
  animeCount,
  searchRef,
  query,
  onQueryChange,
  onSourceChange,
}: TodoHeaderProps) {
  return (
    <>
      <div className="page-heading-row minimal-heading">
        <div>
          <span className="page-kicker">MODE 03</span>
          <h1>Todo</h1>
        </div>
        <div className="heading-right">
          <span className="tracking-summary">{youtubeCount + animeCount} sources</span>
        </div>
      </div>
      <div className="track-source-tabs" role="tablist" aria-label="Tracking source">
        <button
          className={source === "youtube" ? "active" : ""}
          onClick={() => onSourceChange("youtube")}
        >
          <Youtube size={15} /> YouTube <span>{youtubeCount}</span>
        </button>
        <button className={source === "ani" ? "active" : ""} onClick={() => onSourceChange("ani")}>
          <span className="ani-mark">あ</span> Ani <span>{animeCount}</span>
        </button>
        <div className="track-tabs-end">
          <label className="todo-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search /"
            />
          </label>
        </div>
      </div>
    </>
  );
}
