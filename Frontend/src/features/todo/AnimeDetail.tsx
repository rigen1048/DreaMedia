import { ArrowLeft, Check, CheckCheck } from "lucide-react";
import { AnimeCursorForm } from "./AnimeCursorForm";
import { AnimeRangeForm } from "./AnimeRangeForm";
import { AnimeSeasonList } from "./AnimeSeasonList";
import type { AnimeDetailActionProps } from "./types";

export function AnimeDetail({
  show,
  currentSeason,
  onBack,
  onSeason,
  onWatch,
  onCursor,
  onRange,
  onFinish,
  onCanon,
  onDelete,
}: AnimeDetailActionProps) {
  const total = show.seasons.reduce((sum, season) => sum + season.episodes, 0);
  const seasonForCursor =
    currentSeason?.seasonNo ?? show.cursorSeason ?? show.seasons[0]?.seasonNo ?? 1;

  return (
    <section className="detail-workspace anime-detail">
      <div className="detail-breadcrumb">
        <button onClick={onBack}>
          <ArrowLeft size={14} /> All anime
        </button>
        <span>/</span>
        <span>{show.title}</span>
      </div>
      <div className="anime-hero">
        {show.cover ? (
          <div className="anime-cover" style={{ backgroundImage: `url("${show.cover}")` }} />
        ) : (
          <div className="anime-hero-glyph">あ</div>
        )}
        <div className="anime-hero-copy">
          <span className="eyebrow">
            {show.list.toUpperCase()} · {show.status.toUpperCase()}
          </span>
          <h2>{show.title}</h2>
          <div className="anime-title-meta">
            <span>{show.seasons.length} seasons</span>
            <span>{total} episodes</span>
            <span>Anime</span>
            <span>{show.canonOnly ? "Canon only" : "All episodes"}</span>
          </div>
        </div>
      </div>
      <div className="anime-detail-actions">
        <label className="canon-toggle">
          <input
            type="checkbox"
            checked={show.canonOnly}
            onChange={(event) => onCanon(event.target.checked)}
          />
          Canon only
        </label>
        <button className="quiet-action" onClick={onFinish}>
          <CheckCheck size={14} /> Complete all
        </button>
        <button className="quiet-action danger-action" onClick={onDelete}>
          Remove
        </button>
      </div>
      <div className="anime-detail-grid">
        <div className="season-column">
          <div className="season-section-head">
            <h3>
              Seasons <span>{show.seasons.length}</span>
            </h3>
          </div>
          <AnimeSeasonList
            seasons={show.seasons}
            activeSeasonNo={currentSeason?.seasonNo}
            onSelect={onSeason}
          />
        </div>
        <div className="episode-column">
          {currentSeason ? (
            <>
              <div className="episode-panel-head">
                <div>
                  <span className="eyebrow">SEASON {currentSeason.seasonNo}</span>
                  <h3>{currentSeason.name}</h3>
                </div>
                <span className={`season-status season-${currentSeason.status.toLowerCase()}`}>
                  {currentSeason.status}
                </span>
              </div>
              <div className="episode-progress-card">
                <div>
                  <span>Season status</span>
                  <strong>
                    {currentSeason.watched ? currentSeason.episodes : currentSeason.aired}
                    <small> / {currentSeason.episodes} episodes</small>
                  </strong>
                </div>
                <div className="progress-track">
                  <i
                    style={{
                      width: `${
                        currentSeason.episodes
                          ? Math.round(
                              ((currentSeason.watched
                                ? currentSeason.episodes
                                : currentSeason.aired) /
                                currentSeason.episodes) *
                                100,
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
              <AnimeCursorForm
                season={seasonForCursor}
                episode={show.cursorEpisode}
                seconds={show.positionSeconds}
                onSave={onCursor}
              />
              <AnimeRangeForm seasons={show.seasons} onRange={onRange} />
              <button
                className={`complete-season-button ${currentSeason.watched ? "is-done" : ""}`}
                onClick={() => onWatch(currentSeason.seasonNo, !currentSeason.watched)}
              >
                {currentSeason.watched ? (
                  <>
                    <Check size={14} /> Season complete · undo
                  </>
                ) : (
                  <>
                    <CheckCheck size={14} /> Mark season watched
                  </>
                )}
              </button>
            </>
          ) : (
            <div className="minimal-empty">No season data returned.</div>
          )}
        </div>
      </div>
    </section>
  );
}
