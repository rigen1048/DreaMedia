import { useMemo, useState } from "react";
import { Ban, CalendarClock, ChevronDown, ListTree, Sparkles } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState, Thumb } from "../../app/ui";
import { Switch } from "@/components/ui/switch";
import { advanceMessage, timeAgo, formatDate } from "../../lib/format";
import type { AniEntry, AniList } from "../../lib/types";
import { ProgressEditor } from "./ProgressEditor";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const LISTS: { value: AniList; label: string }[] = [
  { value: "watching", label: "Watching" },
  { value: "up_to_date", label: "UpToDate" },
  { value: "next_sequel", label: "Next sequel" },
  { value: "new_anime", label: "New anime" },
  { value: "watchlist", label: "Watchlist" },
];

const FILTERS = [
  { value: "all", label: "All" }, { value: "watching", label: "Watching" },
  { value: "up_to_date", label: "UpToDate" }, { value: "next_sequel", label: "Next sequel" },
  { value: "new_anime", label: "New anime" }, { value: "watchlist", label: "Watchlist" },
  { value: "completed", label: "Completed" }, { value: "blocked", label: "Blocked" },
] as const;

type Props = { search: string; list: string; onList: (value: string) => void; onAdd: () => void };

export default function AnimeTab({ search, list, onList, onAdd }: Props) {
  const workspace = useWorkspace();
  const [expanded, setExpanded] = useState<number | null>(null);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workspace.aniEntries
      .filter((entry) => {
        if (list === "all") return true;
        if (list === "completed" || list === "blocked") return entry.label === list;
        return entry.list === list && entry.label === "none";
      })
      .filter((entry) =>
        query
          ? `${entry.title} ${entry.animeType} ${entry.domain} ${entry.subdomain}`.toLowerCase().includes(query)
          : true,
      );
  }, [list, search, workspace.aniEntries]);

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((item) => (
          <Button
            key={item.value}
            variant="ghost"
            size="sm"
            onClick={() => onList(item.value)}
            className={cn(
              "h-auto gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
              list === item.value ? "bg-primary text-primary-foreground border-transparent hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {item.label}
            <span className="opacity-60">
              {item.value === "all"
                ? workspace.aniEntries.length
                : item.value === "completed" || item.value === "blocked"
                  ? workspace.aniEntries.filter((entry) => entry.label === item.value).length
                  : workspace.aniEntries.filter((entry) => entry.list === item.value).length}
            </span>
          </Button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing in this bucket"
          hint="Track an anime by title — metadata, seasons and episodes are resolved from AniList."
          action={<Button size="sm" onClick={onAdd}>Track anime</Button>}
        />
      ) : (
        <div className="space-y-2">
          {rows.map((entry) => (
            <AnimeCard
              key={entry.id}
              entry={entry}
              expanded={expanded === entry.id}
              onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function AnimeCard({ entry, expanded, onToggle }: { entry: AniEntry; expanded: boolean; onToggle: () => void }) {
  const { act, notify, refresh } = useApp();
  const workspace = useWorkspace();

  const advance = async (fromSeason: number) => {
    try {
      const result = await api.aniAdvanceSeason(entry.id, fromSeason);
      await refresh();
      notify(advanceMessage(result.aniAdvanceSeason), "ok");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not advance", "error");
    }
  };

  const totalEps = entry.episodeCount || 0;
  const progress = totalEps ? Math.min(100, Math.round(((entry.airedCount || 0) / totalEps) * 100)) : 0;
  const percent = totalEps && entry.cursorEpisode
    ? Math.min(100, Math.round(((entry.cursorEpisode || 0) / totalEps) * 100))
    : progress;

  const blockLabel = entry.label === "none" ? "active" : entry.label;

  // P13: show the cursor when set; only derive from seasons (first unwatched,
  // else last) when there is no cursor — up-to-date entries never set one,
  // which is what used to display a stale S1 · E0.
  const seasons = entry.seasons ?? [];
  const inProgress = seasons.find((s) => !s.watched) ?? seasons.at(-1) ?? null;
  const dispSeason = entry.cursorSeason ?? inProgress?.seasonNo ?? 1;
  const dispEpisode = entry.cursorEpisode ?? inProgress?.episodesAired ?? 0;

  return (
    <>
      <article
        className={cn(
          "flex gap-3 rounded-xl border bg-card p-3",
          entry.label === "blocked" && "opacity-60",
        )}
      >
        <Thumb className="aspect-[3/4] w-16 shrink-0 rounded-lg object-cover" src={entry.cover} alt={entry.title ?? "Anime"} />

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="truncate text-sm font-semibold" title={entry.title ?? ""}>{entry.title ?? "Untitled"}</div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <b className="text-foreground/80">{entry.animeType ?? "TV"}</b>
            <span>{entry.totalSeasons || entry.seasons.length} season{(entry.totalSeasons || 1) > 1 ? "s" : ""}</span>
            <span>{entry.episodeCount} eps</span>
            {entry.releaseDate ? <span>{entry.releaseDate.slice(0, 4)}</span> : <span title="Release date unknown">TBA</span>}
            {entry.domain !== "—" && (
              <Badge variant="secondary" className="text-[10px]">
                {entry.subdomain !== "—"
                  ? `${entry.domain} / ${entry.subdomain}`
                  : entry.domain}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>S<b className="text-foreground">{dispSeason}</b> · E<b className="text-foreground">{dispEpisode}</b></span>
            <span>{entry.watchedSeasons}/{entry.totalSeasons || "?"} seasons watched</span>
            {entry.airingTime && (
              <span className="inline-flex items-center gap-0.5"><CalendarClock size={10} /> {entry.airingTime}</span>
            )}
            {entry.nextAiringAt && (
              <span className="inline-flex items-center gap-0.5" title={formatDate(entry.nextAiringAt)}>
                <Sparkles size={10} /> ep {entry.nextAiringEp} {timeAgo(entry.nextAiringAt)}
              </span>
            )}
          </div>

          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${percent}%` }} />
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Select
              value={entry.list}
              onValueChange={(value) => void act(() => api.aniUpdateEntry(entry.id, { listKind: value }), "List updated")}
            >
              <SelectTrigger className="h-8 w-36" aria-label={`List for ${entry.title}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LISTS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {entry.list === "watchlist" && (
              <Select
                value={entry.watchState ?? "unset"}
                onValueChange={(value) =>
                  void act(() => api.aniUpdateEntry(entry.id, { watchState: value === "unset" ? null : value }), "Watchlist updated")
                }
              >
                <SelectTrigger className="h-8 w-32" aria-label="Watchlist certainty">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unset">Unset</SelectItem>
                  <SelectItem value="confirmed">Confirmed</SelectItem>
                  <SelectItem value="maybe">Maybe</SelectItem>
                </SelectContent>
              </Select>
            )}

            <Select
              value={blockLabel}
              onValueChange={(value) =>
                void act(() => api.aniUpdateEntry(entry.id, { label: value === "active" ? "none" : value }), "State updated")
              }
            >
              <SelectTrigger className="h-8 w-32" aria-label="Entry state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="blocked">Blocked</SelectItem>
              </SelectContent>
            </Select>

            <span className="grow" />
            {entry.label !== "blocked" && (
              <Button
                variant="destructive" size="sm"
                onClick={() => void act(() => api.aniUpdateEntry(entry.id, { label: "blocked" }), "Anime blocked")}
                title="Block this anime and suppress notifications"
              >
                <Ban size={11} /> Block
              </Button>
            )}
            <span title={entry.notifyEnabled ? "Release notifications on" : "Release notifications muted"}>
              <Switch
                checked={entry.notifyRelease}
                aria-label={`Release notifications for ${entry.title}`}
                onCheckedChange={(next) => void act(() => api.aniUpdateEntry(entry.id, { notifyRelease: next }))}
              />
            </span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle} aria-label="Seasons">
              <ChevronDown size={12} className={cn("transition-transform", expanded && "rotate-180")} />
            </Button>
          </div>
        </div>
      </article>

      {expanded && (
        <div className="ml-4 space-y-3 rounded-xl border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ListTree size={13} className="text-muted-foreground" />
            <strong className="text-sm">Seasons</strong>
            <span className="text-xs text-muted-foreground">{entry.seasons.length} tracked</span>
            <span className="grow" />
            <ProgressEditor entryId={entry.id} season={entry.cursorSeason ?? 1} episode={entry.cursorEpisode ?? 0} positionSeconds={entry.positionSeconds ?? 0} compact />
            <Button
              size="sm"
              onClick={() =>
                void act(
                  () => api.aniSetCursor(entry.id, entry.cursorSeason ?? 1, (entry.cursorEpisode ?? 0) + 1, 0),
                  "Episode advanced",
                )
              }
            >
              +1 episode
            </Button>
            <Button
              size="sm" variant="secondary"
              title="Finish this season and move on — the backend checks whether the next one is already out"
              onClick={() => void advance(entry.cursorSeason ?? 1)}
            >
              Next season
            </Button>
            <Button size="sm" onClick={() => void act(() => api.aniFinish(entry.id), "Marked completed")}>
              Finish
            </Button>
          </div>

          <div className="divide-y rounded-lg border">
            {entry.seasons.map((season) => (
              <div key={season.seasonNo} className="flex items-center gap-3 px-3 py-2 text-sm">
                {season.poster && (
                  <img
                    src={season.poster}
                    alt={`Season ${season.seasonNo} poster`}
                    className="h-10 w-10 shrink-0 rounded object-cover border border-border"
                  />
                )}
                <b className="w-8">S{season.seasonNo}</b>
                <span className="min-w-0 flex-1 truncate">
                  {season.title ?? `Season ${season.seasonNo}`}
                  <span className="text-muted-foreground"> · {season.state}</span>
                </span>
                <span className="text-xs text-muted-foreground">{season.episodesAired ?? 0}/{season.episodesTotal ?? "?"} ep</span>
                <span
                  className={cn("w-24 text-right text-xs", season.episodesAired ? "text-muted-foreground" : "text-violet-500")}
                  title={season.episodesAired ? "Airing since" : "Announced release"}
                >
                  {formatDate(season.releaseDate ?? season.startDate)}
                </span>
                <Switch
                  checked={season.watched}
                  aria-label={`Mark season ${season.seasonNo} watched`}
                  onCheckedChange={(next) => void act(() => api.aniSetWatched(entry.id, season.seasonNo, next))}
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t pt-3">
            <div className="space-y-1.5">
              <Label>Anime category</Label>
              <Select
                value={entry.subdomainId ? String(entry.subdomainId) : "none"}
                onValueChange={(value) =>
                  void act(
                    () => (value === "none" ? api.aniUpdateEntry(entry.id, { clearCategory: true }) : api.aniAssignEntry(entry.id, Number(value))),
                    "Category attached",
                  )
                }
              >
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorized</SelectItem>
                  {workspace.aniDomains.flatMap((domain) =>
                    domain.subdomains.map((subdomain) => (
                      <SelectItem key={subdomain.id} value={String(subdomain.id)}>
                        {domain.name} / {subdomain.name}
                      </SelectItem>
                    )),
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={entry.animeType ?? "TV"}
                onValueChange={(value) => void act(() => api.aniUpdateEntry(entry.id, { animeType: value }))}
              >
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["TV", "ONA", "OVA", "Movie", "Special", "Music"].map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Release notifications</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  checked={entry.notifyRelease}
                  aria-label={`Release notifications for ${entry.title}`}
                  onCheckedChange={(next) => void act(() => api.aniUpdateEntry(entry.id, { notifyRelease: next }))}
                />
                <span className="text-xs text-muted-foreground">
                  {entry.notifyEnabled ? "Delivering" : "Muted by scope, label or switch"}
                </span>
              </div>
            </div>

            <Button variant="ghost" size="sm" onClick={() => void act(() => api.aniDeleteEntry(entry.id), "Removed")}>
              Remove entry
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
