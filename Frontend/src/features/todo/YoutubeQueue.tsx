import { Youtube } from "lucide-react";
import type { YoutubeTrack } from "../media";

type YoutubeQueueProps = {
  track: YoutubeTrack;
  onOpen: () => void;
};

export function YoutubeQueue({ track, onOpen }: YoutubeQueueProps) {
  const seen = track.videos.filter((video) => video.seen).length;
  const progress = track.videos.length ? Math.round((seen / track.videos.length) * 100) : 0;

  return (
    <button className="media-track-card" onClick={onOpen}>
      <div className="track-art yt-art">
        <span className="art-glyph">{track.title.slice(0, 1).toUpperCase()}</span>
        <span className="art-platform">
          <Youtube size={14} /> YOUTUBE
        </span>
        <span className="art-caption">
          {track.domain}
          <i> / </i>
          {track.subdomain}
        </span>
      </div>
      <div className="media-card-content">
        <div className="media-card-title">
          <div>
            <strong>{track.title}</strong>
            <span>{track.url}</span>
          </div>
        </div>
        <div className="track-progress-line">
          <span>
            <i style={{ width: `${progress}%` }} />
          </span>
          <small>
            {seen}/{track.videos.length} seen
          </small>
        </div>
        <div className="media-card-foot">
          <span>{track.videos.length - seen} unseen</span>
          <span className="open-detail">Open list →</span>
        </div>
      </div>
    </button>
  );
}
