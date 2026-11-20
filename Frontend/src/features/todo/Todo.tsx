import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ListVideo, Plus } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState, Thumb } from "../../app/ui";
import { advanceMessage, timeAgo, formatDate } from "../../lib/format";
import type { PlaylistCard } from "../../lib/types";
import { PlaylistDrawer } from "./PlaylistDrawer";
import { ProgressEditor } from "../management/ProgressEditor";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const LIST_FILTERS: Array<[string, string]> = [
  ["all", "All"], ["watching", "Watching"], ["up_to_date", "UpToDate"],
  ["next_sequel", "Next sequel"], ["new_anime", "New anime"], ["watchlist", "Watchlist"],
];

export default function Todo() {
  const workspace = useWorkspace();
  const { notify, refresh } = useApp();
  const [name, setName] = useState("");
  const [openCard, setOpenCard] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const createPlaylist = async () => {
    const next = name.trim();
    if (!next) {
      nameRef.current?.focus();
      notify("Give the playlist a name first", "error");
      return;
    }
    try {
      const { ytCreateCard: cardId } = await api.ytCreateCard(next);
      setName("");
      await refresh();
      notify("Playlist created", "ok");
      setOpenCard(cardId);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The backend rejected this change.", "error");
    }
  };

  const [listFilter, setListFilter] = useState("all");

  const queue = useMemo(
    () =>
      workspace.aniEntries
        .filter((entry) => entry.label === "none" && entry.active)
        .filter((entry) => listFilter === "all" || entry.list === listFilter)
        .sort((a, b) => {
          const rank: Record<string, number> = { watching: 0, up_to_date: 1, next_sequel: 2, new_anime: 3, watchlist: 4 };
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
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Todo</h1>
          <p className="text-xs text-muted-foreground">Playlists are standalone; the anime queue follows your management cursors.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <b className="text-foreground">{workspace.ytCards.length}</b> playlists ·{" "}
          <b className="text-foreground">{counts.all}</b> anime cards
        </div>
      </div>

      {/* Playlists */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Custom playlist</h2>
          <span className="text-xs text-muted-foreground">Built from video links only — never from notification data.</span>
          <div className="ml-auto flex gap-2">
            <Input
              ref={nameRef}
              className="h-8 w-48"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New playlist name"
              aria-label="New playlist name"
              onKeyDown={(event) => { if (event.key === "Enter") void createPlaylist(); }}
            />
            <Button size="sm" title="Create a playlist, then paste video links" onClick={() => void createPlaylist()}>
              <Plus size={13} /> Playlist
            </Button>
          </div>
        </div>

        {workspace.ytCards.length === 0 ? (
          <EmptyState title="No playlists yet" hint="Create a playlist, then paste YouTube links — the backend resolves titles and thumbnails." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {workspace.ytCards.map((card) => (
              <PlaylistTile key={card.id} card={card} onOpen={() => setOpenCard(card.id)} />
            ))}
          </div>
        )}
      </section>

      {openCard !== null && <PlaylistDrawer cardId={openCard} onClose={() => setOpenCard(null)} />}

      {/* Anime queue */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Halfway</h2>
          <span className="text-xs text-muted-foreground">Every tracked entry — cursors update Management and notifications.</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {LIST_FILTERS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setListFilter(value)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                listFilter === value ? "bg-primary text-primary-foreground border-transparent" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
              <span className="opacity-60">{counts[value] ?? 0}</span>
            </button>
          ))}
        </div>

        {queue.length === 0 ? (
          <EmptyState title="No anime cards here" hint="Track anime from Management, then it appears here." />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
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
      onClick={onOpen}
      aria-label={`Open playlist ${card.name ?? "untitled"}`}
      className="group flex flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-accent/50 cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <ListVideo size={13} className="text-sky-500" />
        <span className="truncate text-sm font-medium">{card.name ?? "Untitled"}</span>
        <span className="ml-auto text-xs text-muted-foreground">{card.done}/{card.total}</span>
      </div>

      <div className="flex gap-1.5">
        {preview.map((item) =>
          item.thumbnail ? (
            <img key={item.id} src={item.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="aspect-video w-20 rounded object-cover" />
          ) : (
            <span key={item.id} className="aspect-video w-20 rounded bg-muted" />
          ),
        )}
        {preview.length === 0 && <span className="text-xs text-muted-foreground">No videos yet — open to add</span>}
        {card.items.length > 3 && (
          <span className="flex w-10 items-center justify-center rounded bg-muted text-xs text-muted-foreground">+{card.items.length - 3}</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs text-muted-foreground">{percent}%</span>
        <ChevronRight size={13} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
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
    entry.list === "watching" ? "watching"
      : entry.list === "next_sequel" ? "next sequel"
        : entry.list === "new_anime" ? "new anime"
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
      ref={ref as never}
      className={cn(
        "flex gap-3 rounded-xl border bg-card p-3",
        highlight && "border-violet-500 shadow-[0_0_0_2px] shadow-violet-500/30",
      )}
    >
      <Thumb className="aspect-[3/4] w-20 object-cover rounded-lg" src={entry.cover} alt={entry.title ?? "Anime"} />

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="truncate text-sm font-semibold">{entry.title}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{entry.animeType ?? "TV"}</span>
          <span>{entry.totalSeasons || entry.seasons.length || 1} season{(entry.totalSeasons || 1) > 1 ? "s" : ""}</span>
          <span>{entry.episodeCount} eps</span>
          <span>{entry.releaseDate ? formatDate(entry.releaseDate) : "date TBA"}</span>
          <Badge variant="secondary" className="text-[10px]">{label}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>S<b className="text-foreground">{season}</b> · E<b className="text-foreground">{episode}</b>{seasonEps ? ` / ${seasonEps}` : ""}</span>
          <span>{entry.airedCount}/{entry.episodeCount} aired</span>
          {entry.nextAiringAt ? (
            <span>ep {entry.nextAiringEp} {timeAgo(entry.nextAiringAt)}</span>
          ) : (
            <span>{entry.airingTime ?? (entry.episodeCount && entry.airedCount >= entry.episodeCount ? "aired" : "no schedule")}</span>
          )}
          {nextSeason && (nextSeason.releaseDate || nextSeason.startDate) && (
            <span title="Next season">S{nextSeason.seasonNo} · {formatDate(nextSeason.releaseDate ?? nextSeason.startDate)}</span>
          )}
        </div>

        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${percent}%` }} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {entry.list === "watching" || entry.list === "next_sequel" ? (
            <>
              <Button size="sm" onClick={() => void act(() => api.aniSetCursor(entry.id, season, episode + 1, 0), `Watched S${season} E${episode + 1}`)}>
                +1 episode
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void advance()}>Next season</Button>
              <Button size="sm" variant="ghost" onClick={() => void act(() => api.aniFinish(entry.id), "Completed")}>Finish</Button>
              <ProgressEditor entryId={entry.id} season={season} episode={episode} positionSeconds={entry.positionSeconds ?? 0} compact />
            </>
          ) : (
            <Button size="sm" onClick={() => void act(() => api.aniUpdateEntry(entry.id, { listKind: "watching" }), "Moved to watching")}>
              Start watching
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
