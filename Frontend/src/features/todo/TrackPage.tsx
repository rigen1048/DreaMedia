import { useMedia } from "../media";
import { AnimeDetail } from "./AnimeDetail";
import { AnimeOverview } from "./AnimeOverview";
import { TodoHeader } from "./TodoHeader";
import { YoutubeDetail } from "./YoutubeDetail";
import { YoutubeQueue } from "./YoutubeQueue";
import { useTodoSelection } from "./useTodoSelection";

export default function TrackPage() {
  const {
    youtubeTracks,
    anime,
    markVideosSeen,
    updateAnime,
    setSeasonWatched,
    setAnimeCursor,
    markAnimeRange,
    finishAnime,
    deleteAnime,
  } = useMedia();
  const selection = useTodoSelection();

  return (
    <div className="page-content track-page minimal-page">
      <TodoHeader
        source={selection.source}
        youtubeCount={youtubeTracks.length}
        animeCount={anime.length}
        searchRef={selection.searchRef}
        query={selection.query}
        onQueryChange={selection.setQuery}
        onSourceChange={selection.switchSource}
      />
      {selection.error && (
        <div className="inline-api-error" role="alert">
          {selection.error}
        </div>
      )}

      {selection.source === "youtube" && !selection.activeTrack && (
        <section className="tracker-overview">
          <div className="tracker-section-heading">
            <h2>YouTube</h2>
            <span className="tracker-count">{selection.visibleYoutube.length} queues</span>
          </div>
          <div className="media-card-grid youtube-grid">
            {selection.visibleYoutube.map((track) => (
              <YoutubeQueue
                key={track.id}
                track={track}
                onOpen={() => selection.openYoutube(track.channelId)}
              />
            ))}
            {selection.visibleYoutube.length === 0 && (
              <div className="minimal-empty">
                No active YouTube subscriptions returned by the backend.
              </div>
            )}
          </div>
        </section>
      )}

      {selection.source === "youtube" && selection.activeTrack && (
        <YoutubeDetail
          track={selection.activeTrack}
          onBack={selection.back}
          onSeen={(videoId, seen) => void selection.run(() => markVideosSeen([videoId], seen))}
        />
      )}

      {selection.source === "ani" && !selection.activeShow && (
        <AnimeOverview
          visibleAnime={selection.visibleAnime}
          animeFilter={selection.animeFilter}
          onFilterChange={selection.setAnimeFilter}
          addOpen={selection.addOpen}
          onToggleAdd={() => selection.setAddOpen((value) => !value)}
          animeTitle={selection.animeTitle}
          onTitleChange={selection.setAnimeTitle}
          animeList={selection.animeList}
          onListChange={selection.setAnimeList}
          onSubmit={selection.submitAnime}
          onOpen={selection.openAnime}
        />
      )}

      {selection.source === "ani" && selection.activeShow && (
        <AnimeDetail
          show={selection.activeShow}
          currentSeason={selection.currentSeason}
          onBack={selection.back}
          onSeason={selection.setActiveSeasonNo}
          onWatch={(seasonNo, watched) =>
            void selection.run(() =>
              setSeasonWatched(selection.activeShow!.backendId, seasonNo, watched),
            )
          }
          onCursor={(season, episode, seconds) =>
            void selection.run(() =>
              setAnimeCursor(selection.activeShow!.backendId, season, episode, seconds),
            )
          }
          onRange={(from, to) =>
            void selection.run(() => markAnimeRange(selection.activeShow!.backendId, from, to))
          }
          onFinish={() => void selection.run(() => finishAnime(selection.activeShow!))}
          onCanon={(value) =>
            void selection.run(() =>
              updateAnime(selection.activeShow!.backendId, {
                canon_only: value,
              }),
            )
          }
          onDelete={() => {
            if (window.confirm(`Remove ${selection.activeShow!.title} from tracking?`)) {
              void selection.run(() => deleteAnime(selection.activeShow!.backendId));
            }
          }}
        />
      )}
    </div>
  );
}
