import type { SeasonListProps } from "./types";

export function AnimeSeasonList({ seasons, activeSeasonNo, onSelect }: SeasonListProps) {
  return (
    <div className="season-list">
      {seasons.map((season) => (
        <button
          key={season.id}
          className={`season-select-row ${activeSeasonNo === season.seasonNo ? "active" : ""}`}
          onClick={() => onSelect(season.seasonNo)}
        >
          <span className="season-index">S{season.seasonNo}</span>
          <span className="season-row-copy">
            <strong>{season.name}</strong>
            <span>
              {season.episodes} episodes · {season.aired} aired
            </span>
          </span>
          <span className={`season-status season-${season.status.toLowerCase()}`}>
            {season.status}
          </span>
        </button>
      ))}
    </div>
  );
}
