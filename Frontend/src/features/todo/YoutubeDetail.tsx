import { ArrowLeft, Check, Circle } from "lucide-react";
import type { YoutubeDetailProps } from "./types";

export function YoutubeDetail({ track, onBack, onSeen }: YoutubeDetailProps) {
  return (
    <section className="detail-workspace">
      <div className="detail-breadcrumb">
        <button onClick={onBack}>
          <ArrowLeft size={14} /> All YouTube
        </button>
        <span>/</span>
        <span>{track.title}</span>
      </div>
      <div className="detail-title-row">
        <div className="detail-channel-mark">{track.title.slice(0, 1).toUpperCase()}</div>
        <div className="detail-title-copy">
          <span className="eyebrow">YOUTUBE TODO</span>
          <h2>{track.title}</h2>
          <span>
            {track.domain} / {track.subdomain}
          </span>
        </div>
      </div>
      <div className="video-todo-heading">
        <h3>
          Videos <span>{track.videos.length}</span>
        </h3>
        <span className="muted-status">Click a circle to persist seen state</span>
      </div>
      <div className="video-todo-list">
        {track.videos.map((video) => (
          <div key={video.id} className={`video-todo-row ${video.seen ? "completed" : ""}`}>
            <button
              className={`todo-check ${video.seen ? "checked" : ""}`}
              onClick={() => onSeen(video.id, !video.seen)}
              aria-label={video.seen ? "Mark unseen" : "Mark seen"}
            >
              {video.seen ? <Check size={14} /> : <Circle size={14} />}
            </button>
            <div
              className="video-thumb real-thumb"
              style={video.thumbnail ? { backgroundImage: `url("${video.thumbnail}")` } : undefined}
            >
              <span>YT</span>
            </div>
            <div className="video-todo-copy">
              <strong>{video.title}</strong>
              <span>
                {video.channel} · {video.age}
              </span>
            </div>
            <span className={`video-status ${video.seen ? "done" : ""}`}>
              {video.seen ? "Seen" : "New"}
            </span>
            {video.url && (
              <a
                className="play-row"
                href={video.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${video.title}`}
              >
                ↗
              </a>
            )}
          </div>
        ))}
        {track.videos.length === 0 && (
          <div className="minimal-empty">No video feed returned for this channel yet.</div>
        )}
      </div>
    </section>
  );
}
