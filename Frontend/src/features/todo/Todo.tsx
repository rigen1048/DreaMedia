import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ListVideo, Plus } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState, Thumb } from "../../app/ui";
import { advanceMessage, timeAgo, formatDate } from "../../lib/format";
import type { PlaylistCard } from "../../lib/types";
import { PlaylistDrawer } from "./PlaylistDrawer";
import { ProgressEditor } from "../management/ProgressEditor";

export default function Todo() {
  const workspace = useWorkspace();
  const { notify, refresh } = useApp();
  const [name, setName] = useState("");
  const [openCard, setOpenCard] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const createPlaylist = async () => {
    const next = name.trim();
    if (!next) {
      // This button used to be disabled while the field was empty: it looked
      // exactly like an enabled one and silently swallowed the click. Ask for
      // the name instead, and put the caret where it is needed.
      nameRef.current?.focus();
      notify("Give the playlist a name first", "error");
      return;
    }
    try {
      const { ytCreateCard: cardId } = await api.ytCreateCard(next);
      setName("");
      await refresh();
      notify("Playlist created", "ok");
      // Open it straight away — the next step is always pasting links.
      setOpenCard(cardId);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "The backend rejected this change.",
        "error",
      );
    }
  };

  const [listFilter, setListFilter] = useState("all");

  const queue = useMemo(
    () =>
      workspace.aniEntries
        .filter((entry) => entry.label === "none" && entry.active)
        .filter((entry) => listFilter === "all" || entry.list === listFilter)
        .sort((a, b) => {
          const rank: Record<string, number> = {
            watching: 0,
            up_to_date: 1,
            next_sequel: 2,
            new_anime: 3,
            watchlist: 4,
          };
          const byList = (rank[a.list] ?? 9) - (rank[b.list] ?? 9);
          if (byList !== 0) return byList;
          const next = (a.nextAiringAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAiringAt ?? Number.MAX_SAFE_INTEGER);
          if (next !== 0) return next;
          return a.title?.localeCompare(b.title ?? "") ?? 0;
        }),
    [workspace.aniEntries, listFilter],
  );

  const counts = useMemo(() => {
    const all = workspace.aniEntries.filter((entry) => entry.label === "none" && entry.active);
    return {
      all: all.length,
      watching: all.filter((entry) => entry.list === "watching").length,
      up_to_date: all.filter((entry) => entry.list === "up_to_date").length,
      next_sequel: all.filter((entry) => entry.list === "next_sequel").length,
      new_anime: all.filter((entry) => entry.list === "new_anime").length,
      watchlist: all.filter((entry) => entry.list === "watchlist").length,
    } as Record<string, number>;
  }, [workspace.aniEntries]);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__title">
          <h1>Todo</h1>
          <p>Playlists are standalone; the anime queue follows your management cursors.</p>
        </div>
        <div className="page-head__actions">
          <div className="metrics">
            <span>
              <b>{workspace.ytCards.length}</b> playlists
            </span>
            <span className="sep" />
            <span>
              <b>{counts.all}</b> anime cards
            </span>
          </div>
        </div>
      </div>

      <section className="todo-section">
        <div className="section-head">
          <h2>Playlists</h2>
          <span>Built from video links only — never from notification data.</span>
          <span className="grow" />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              ref={nameRef}
              className="input"
              style={{ width: 190, height: 30, fontSize: 12 }}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New playlist name"
              aria-label="New playlist name"
              onKeyDown={(event) => {
                if (event.key === "Enter") void createPlaylist();
              }}
            />
            <button
              className="btn btn--sm"
              title="Create a playlist, then paste video links"
              onClick={() => void createPlaylist()}
            >
              <Plus size={13} /> Playlist
            </button>
          </div>
        </div>

        {workspace.ytCards.length === 0 ? (
          <div className="table">
            <EmptyState
              title="No playlists yet"
              hint="Create a playlist, then paste YouTube links — the backend resolves titles and thumbnails."
            />
          </div>
        ) : (
          <div className="playlist-grid">
            {workspace.ytCards.map((card) => (
              <PlaylistTile key={card.id} card={card} onOpen={() => setOpenCard(card.id)} />
            ))}
          </div>
        )}
      </section>

      {openCard !== null && (
        <PlaylistDrawer cardId={openCard} onClose={() => setOpenCard(null)} />
      )}

      <section className="todo-section">
        <div className="section-head">
          <h2>Anime</h2>
          <span>Every tracked entry — cursors update Management and notifications.</span>
        </div>

        <div className="filterbar" style={{ marginBottom: 10 }}>
          {[
            ["all", "All"],
            ["watching", "Watching"],
            ["up_to_date", "UpToDate"],
            ["next_sequel", "Next sequel"],
            ["new_anime", "New anime"],
            ["watchlist", "Watchlist"],
          ].map(([value, label]) => (
            <button
              key={value}
              className="chipbtn"
              data-active={listFilter === value}
              onClick={() => setListFilter(value)}
            >
              {label}
              <span className="count">{counts[value] ?? 0}</span>
            </button>
          ))}
        </div>

        {queue.length === 0 ? (
          <div className="table">
            <EmptyState
              title="No anime cards here"
              hint="Track anime from Management, then it appears here."
            />
          </div>
        ) : (
          <div className="queue-grid">
            {queue.map((entry) => (
              <QueueCard key={entry.id} entryId={entry.id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PlaylistTile({ card, onOpen }: { card: PlaylistCard; onOpen: () => void }) {
  const percent = card.total ? Math.round((card.done / card.total) * 100) : 0;
  const preview = card.items.slice(0, 3);

  return (
    <button
      className="playlist-tile"
      onClick={onOpen}
      aria-label={`Open playlist ${card.name ?? "untitled"}`}
    >
      <span className="playlist-tile__head">
        <ListVideo size={13} style={{ color: "var(--accent)" }} />
        <span className="playlist-tile__name">{card.name ?? "Untitled"}</span>
        <span className="count">{card.done}/{card.total}</span>
      </span>

      <span className="playlist-tile__peek">
        {preview.map((item) =>
          item.thumbnail ? (
            <img
              key={item.id}
              src={item.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span key={item.id} className="playlist-tile__thumb-fallback" />
          ),
        )}
        {preview.length === 0 && (
          <span className="playlist-tile__empty">No videos yet — open to add</span>
        )}
        {card.items.length > 3 && (
          <span className="playlist-tile__more">+{card.items.length - 3}</span>
        )}
      </span>

      <span className="playlist-tile__foot">
        <span className="progress">
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="faint">{percent}%</span>
        <ChevronRight size={13} className="playlist-tile__chevron" />
      </span>
    </button>
  );
}

function QueueCard({ entryId }: { entryId: number }) {
  const workspace = useWorkspace();
  const { act, notify, refresh } = useApp();
  const entry = workspace.aniEntries.find((item) => item.id === entryId);
  const ref = useRef<HTMLElement | null>(null);
  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("entry");
    if (param && Number(param) === entryId) {
      setHighlight(true);
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      const timer = window.setTimeout(() => setHighlight(false), 3600);
      return () => window.clearTimeout(timer);
    }
  }, [entryId]);

  if (!entry) return null;

  const season = entry.cursorSeason ?? 1;
  const episode = entry.cursorEpisode ?? 0;
  const currentSeason = entry.seasons.find((item) => item.seasonNo === season);
  const seasonEps = currentSeason?.episodesTotal ?? null;
  const nextSeason = entry.seasons.find((item) => item.seasonNo === season + 1);
  const percent = seasonEps
    ? Math.min(100, Math.round((episode / seasonEps) * 100))
    : entry.episodeCount
      ? Math.min(100, Math.round((episode / entry.episodeCount) * 100))
      : 0;
  const label =
    entry.list === "watching"
      ? "watching"
      : entry.list === "next_sequel"
        ? "next sequel"
        : entry.list === "new_anime"
          ? "new anime"
          : (entry.watchState ?? "watchlist");

  const advance = async () => {
    try {
      const result = await api.aniAdvanceSeason(entry.id, season);
      await refresh();
      notify(advanceMessage(result.aniAdvanceSeason), "ok");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not advance", "error");
    }
  };

  return (
    <article
      className="queue-card"
      ref={ref as never}
      style={
        highlight
          ? { borderColor: "var(--ani)", boxShadow: "0 0 0 2px var(--ani-soft)" }
          : undefined
      }
    >
      <Thumb className="queue-cover" src={entry.cover} alt={entry.title ?? "Anime"} />

      <div className="queue-body">
        <div className="queue-title">{entry.title}</div>
        <div className="queue-meta">
          <span>{entry.animeType ?? "TV"}</span>
          <span>
            {entry.totalSeasons || entry.seasons.length || 1} season
            {(entry.totalSeasons || 1) > 1 ? "s" : ""}
          </span>
          <span>{entry.episodeCount} eps</span>
          <span>{entry.releaseDate ? formatDate(entry.releaseDate) : "date TBA"}</span>
          <span className="chip chip--muted" style={{ fontSize: 9, padding: "0 5px" }}>
            {label}
          </span>
        </div>
        <div className="queue-meta">
          <span>
            S<b>{season}</b> · E<b>{episode}</b>
            {seasonEps ? ` / ${seasonEps}` : ""}
          </span>
          <span>
            {entry.airedCount}/{entry.episodeCount} aired
          </span>
          {entry.nextAiringAt ? (
            <span>
              ep {entry.nextAiringEp} {timeAgo(entry.nextAiringAt)}
            </span>
          ) : (
            <span>
              {entry.airingTime ??
                (entry.episodeCount && entry.airedCount >= entry.episodeCount ? "aired" : "no schedule")}
            </span>
          )}
          {nextSeason && (nextSeason.releaseDate || nextSeason.startDate) && (
            <span title="Next season">
              S{nextSeason.seasonNo} · {formatDate(nextSeason.releaseDate ?? nextSeason.startDate)}
            </span>
          )}
        </div>

        <div className="progress progress--ani" style={{ margin: "3px 0 3px" }}>
          <span style={{ width: `${percent}%` }} />
        </div>

        <div className="queue-actions">
          {entry.list === "watching" || entry.list === "next_sequel" ? (
            <>
              <button
                className="btn btn--sm btn--primary"
                onClick={() =>
                  void act(
                    () => api.aniSetCursor(entry.id, season, episode + 1, 0),
                    `Watched S${season} E${episode + 1}`,
                  )
                }
              >
                +1 episode
              </button>
              <button
                className="btn btn--sm"
                onClick={() => void advance()}
              >
                Next season
              </button>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => void act(() => api.aniFinish(entry.id), "Completed")}
              >
                Finish
              </button>
              <ProgressEditor entryId={entry.id} season={season} episode={episode} compact />
            </>
          ) : (
            <button
              className="btn btn--sm btn--primary"
              onClick={() =>
                void act(
                  () => api.aniUpdateEntry(entry.id, { listKind: "watching" }),
                  "Moved to watching",
                )
              }
            >
              Start watching
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
