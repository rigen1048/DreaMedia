import { Plus } from "lucide-react";
import type { FormEvent, Dispatch, SetStateAction } from "react";
import type { AnimeTrack } from "../media";
import { AnimeQueue } from "./AnimeQueue";

type AnimeOverviewProps = {
  visibleAnime: AnimeTrack[];
  animeFilter: string;
  onFilterChange: (filter: string) => void;
  addOpen: boolean;
  onToggleAdd: () => void;
  animeTitle: string;
  onTitleChange: (title: string) => void;
  animeList: AnimeTrack["list"];
  onListChange: Dispatch<SetStateAction<AnimeTrack["list"]>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  onOpen: (show: AnimeTrack) => void;
};

export function AnimeOverview({
  visibleAnime,
  animeFilter,
  onFilterChange,
  addOpen,
  onToggleAdd,
  animeTitle,
  onTitleChange,
  animeList,
  onListChange,
  onSubmit,
  onOpen,
}: AnimeOverviewProps) {
  return (
    <section className="tracker-overview anime-overview">
      <div className="tracker-section-heading">
        <h2>Ani</h2>
        <div className="tracker-actions">
          <select
            className="status-filter"
            value={animeFilter}
            onChange={(event) => onFilterChange(event.target.value)}
          >
            <option>All</option>
            <option>Watching</option>
            <option>Completed</option>
          </select>
          <button className="quiet-action" onClick={onToggleAdd}>
            <Plus size={14} /> Track anime
          </button>
        </div>
      </div>
      {addOpen && (
        <form className="add-source-form" onSubmit={onSubmit}>
          <label>
            Anime title
            <input
              autoFocus
              required
              value={animeTitle}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="Title to search through AniList"
            />
          </label>
          <label>
            List
            <select
              value={animeList}
              onChange={(event) => onListChange(event.target.value as AnimeTrack["list"])}
            >
              <option value="watchlist">Watchlist</option>
              <option value="confirmed">Confirmed</option>
              <option value="watching">Watching</option>
            </select>
          </label>
          <button className="primary-button">Add through backend</button>
        </form>
      )}
      <div className="media-card-grid anime-grid">
        {visibleAnime.map((show) => (
          <AnimeQueue key={show.id} show={show} onOpen={() => onOpen(show)} />
        ))}
        {visibleAnime.length === 0 && (
          <div className="minimal-empty">No anime entries returned by the backend.</div>
        )}
      </div>
    </section>
  );
}
