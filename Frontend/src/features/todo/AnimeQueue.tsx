import { Tv2 } from "lucide-react";
import type { AnimeTrack } from "../media";

type AnimeQueueProps = {
  show: AnimeTrack;
  onOpen: () => void;
};

export function AnimeQueue({ show, onOpen }: AnimeQueueProps) {
  const total = show.seasons.reduce((sum, season) => sum + season.episodes, 0);

  return (
    <button className="media-track-card anime-card" onClick={onOpen}>
      <div
        className="track-art anime-art"
        style={
          show.cover
            ? {
                backgroundImage: `linear-gradient(110deg, rgba(15,16,12,.9), rgba(15,16,12,.35)), url("${show.cover}")`,
              }
            : undefined
        }
      >
        <span className="anime-art-meta">ANIME · {show.list.toUpperCase()}</span>
        <span className="anime-art-title">{show.title}</span>
        <span className="art-caption">{show.status}</span>
      </div>
      <div className="media-card-content">
        <div className="media-card-title">
          <div>
            <strong>{show.title}</strong>
            <span>
              {show.seasons.length} seasons · {total} episodes
            </span>
          </div>
          <span className={`status-badge ${show.status.toLowerCase()}`}>{show.status}</span>
        </div>
        <div className="media-card-foot">
          <span>
            <Tv2 size={14} /> Cursor · S{show.cursorSeason ?? "—"} E{show.cursorEpisode ?? "—"}
          </span>
          <span className="open-detail">Open →</span>
        </div>
      </div>
    </button>
  );
}
