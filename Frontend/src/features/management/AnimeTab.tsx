import { useMemo, useState } from "react";
import { Ban, CalendarClock, ChevronDown, ListTree, Plus, Sparkles } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState, MiniSwitch, Switch, Thumb } from "../../app/ui";
import { advanceMessage, timeAgo, formatDate } from "../../lib/format";
import type { AniEntry, AniList } from "../../lib/types";
import { ProgressEditor } from "./ProgressEditor";

const LISTS: { value: AniList; label: string }[] = [
  { value: "watching", label: "Watching" },
  { value: "up_to_date", label: "UpToDate" },
  { value: "next_sequel", label: "Next sequel" },
  { value: "new_anime", label: "New anime" },
  { value: "watchlist", label: "Watchlist" },
];

const FILTERS = [
  { value: "all", label: "All" },
  { value: "watching", label: "Watching" },
  { value: "up_to_date", label: "UpToDate" },
  { value: "next_sequel", label: "Next sequel" },
  { value: "new_anime", label: "New anime" },
  { value: "watchlist", label: "Watchlist" },
  { value: "completed", label: "Completed" },
  { value: "blocked", label: "Blocked" },
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
          ? `${entry.title} ${entry.animeType} ${entry.domain} ${entry.subdomain}`
              .toLowerCase()
              .includes(query)
          : true,
      );
  }, [list, search, workspace.aniEntries]);

  return (
    <>
      <div className="filterbar" style={{ marginBottom: 12 }}>
        {FILTERS.map((item) => (
          <button
            key={item.value}
            className="chipbtn"
            data-active={list === item.value}
            onClick={() => onList(item.value)}
          >
            {item.label}
            <span className="count">
              {item.value === "all"
                ? workspace.aniEntries.length
                : item.value === "completed" || item.value === "blocked"
                  ? workspace.aniEntries.filter((entry) => entry.label === item.value).length
                  : workspace.aniEntries.filter((entry) => entry.list === item.value).length}
            </span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="table">
          <EmptyState
            title="Nothing in this bucket"
            hint="Track an anime by title — metadata, seasons and episodes are resolved from AniList."
            action={
              <button className="btn btn--sm btn--primary" onClick={onAdd}>
                Track anime
              </button>
            }
          />
        </div>
      ) : (
        <div className="ani-grid">
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

function AnimeCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: AniEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
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
  const progress = totalEps
    ? Math.min(100, Math.round(((entry.airedCount || 0) / totalEps) * 100))
    : 0;
  const percent =
    totalEps && entry.cursorEpisode
      ? Math.min(100, Math.round(((entry.cursorEpisode || 0) / totalEps) * 100))
      : progress;

  const blockLabel = entry.label === "none" ? "active" : entry.label;

  return (
    <>
      <article className="ani-card" data-blocked={entry.label === "blocked"}>
        <Thumb className="ani-cover" src={entry.cover} alt={entry.title ?? "Anime"} />

        <div className="ani-body">
          <div className="ani-title" title={entry.title ?? ""}>
            {entry.title ?? "Untitled"}
          </div>

          <div className="ani-meta">
            <span>
              <b>{entry.animeType ?? "TV"}</b>
            </span>
            <span>
              {entry.totalSeasons || entry.seasons.length} season
              {(entry.totalSeasons || 1) > 1 ? "s" : ""}
            </span>
            <span>{entry.episodeCount} eps</span>
            {entry.releaseDate ? (
              <span>{entry.releaseDate.slice(0, 4)}</span>
            ) : (
              <span title="Release date unknown">TBA</span>
            )}
            <span className="chip chip--muted" style={{ padding: "0 5px", fontSize: 9 }}>
              {entry.domain !== "—" ? `${entry.domain} / ${entry.subdomain}` : "uncategorized"}
            </span>
          </div>

          <div className="ani-meta">
            <span>
              S<b>{entry.cursorSeason ?? 1}</b> · E<b>{entry.cursorEpisode ?? 0}</b>
            </span>
            <span>
              {entry.watchedSeasons}/{entry.totalSeasons || "?"} seasons watched
            </span>
            {entry.airingTime && (
              <span>
                <CalendarClock size={10} style={{ verticalAlign: -1 }} /> {entry.airingTime}
              </span>
            )}
            {entry.nextAiringAt && (
              <span title={formatDate(entry.nextAiringAt)}>
                <Sparkles size={10} style={{ verticalAlign: -1 }} /> ep {entry.nextAiringEp}{" "}
                {timeAgo(entry.nextAiringAt)}
              </span>
            )}
          </div>

          <div className="ani-progress">
            <div className="progress progress--ani">
              <span style={{ width: `${percent}%` }} />
            </div>
          </div>

          <div className="ani-controls">
            <select
              className="select"
              value={entry.list}
              aria-label={`List for ${entry.title}`}
              onChange={(event) =>
                void act(
                  () => api.aniUpdateEntry(entry.id, { listKind: event.target.value }),
                  "List updated",
                )
              }
            >
              {LISTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>

            {entry.list === "watchlist" && (
              <select
                className="select"
                value={entry.watchState ?? ""}
                aria-label="Watchlist certainty"
                onChange={(event) =>
                  void act(
                    () => api.aniUpdateEntry(entry.id, { watchState: event.target.value || null }),
                    "Watchlist updated",
                  )
                }
              >
                <option value="">Unset</option>
                <option value="confirmed">Confirmed</option>
                <option value="maybe">Maybe</option>
              </select>
            )}

            <select
              className="select"
              value={blockLabel}
              aria-label="Entry state"
              onChange={(event) =>
                void act(
                  () =>
                    api.aniUpdateEntry(entry.id, {
                      label: event.target.value === "active" ? "none" : event.target.value,
                    }),
                  "State updated",
                )
              }
            >
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="blocked">Blocked</option>
            </select>

            <span className="grow" />
            {entry.label !== "blocked" && (
              <button
                className="btn btn--sm btn--danger"
                onClick={() =>
                  void act(() => api.aniUpdateEntry(entry.id, { label: "blocked" }), "Anime blocked")
                }
                title="Block this anime and suppress notifications"
              >
                <Ban size={11} /> Block
              </button>
            )}
            <span
              title={
                entry.notifyEnabled ? "Release notifications on" : "Release notifications muted"
              }
            >
              <MiniSwitch
                checked={entry.notifyRelease}
                label={`Release notifications for ${entry.title}`}
                onChange={(next) =>
                  void act(() => api.aniUpdateEntry(entry.id, { notifyRelease: next }))
                }
              />
            </span>
            <button
              className="icon-btn"
              style={{ width: 24, height: 24 }}
              onClick={onToggle}
              aria-label="Seasons"
            >
              <ChevronDown
                size={12}
                style={{ transform: expanded ? "rotate(180deg)" : undefined }}
              />
            </button>
          </div>
        </div>
      </article>

      {expanded && (
        <div className="ani-detail">
          <div className="ani-detail__head">
            <ListTree size={13} />
            <strong>Seasons</strong>
            <span>{entry.seasons.length} tracked</span>
            <span className="grow" />
            <ProgressEditor
              entryId={entry.id}
              season={entry.cursorSeason ?? 1}
              episode={entry.cursorEpisode ?? 0}
              compact
            />
            <button
              className="btn btn--sm"
              onClick={() =>
                void act(
                  () =>
                    api.aniSetCursor(
                      entry.id,
                      entry.cursorSeason ?? 1,
                      (entry.cursorEpisode ?? 0) + 1,
                      0,
                    ),
                  "Episode advanced",
                )
              }
            >
              +1 episode
            </button>
            <button
              className="btn btn--sm"
              title="Finish this season and move on — the backend checks whether the next one is already out"
              onClick={() => void advance(entry.cursorSeason ?? 1)}
            >
              Next season
            </button>
            <button
              className="btn btn--sm btn--primary"
              onClick={() => void act(() => api.aniFinish(entry.id), "Marked completed")}
            >
              Finish
            </button>
          </div>

          <div className="season-bar">
            {entry.seasons.map((season) => (
              <div className="season-row" key={season.seasonNo}>
                <b>S{season.seasonNo}</b>
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {season.title ?? `Season ${season.seasonNo}`}
                  <span style={{ color: "var(--faint)" }}> · {season.state}</span>
                </span>
                <span>
                  {season.episodesAired ?? 0}/{season.episodesTotal ?? "?"} ep
                </span>
                <span
                  style={{
                    textAlign: "right",
                    whiteSpace: "nowrap",
                    color: season.episodesAired ? "var(--faint)" : "var(--ani)",
                  }}
                  title={season.episodesAired ? "Airing since" : "Announced release"}
                >
                  {formatDate(season.releaseDate ?? season.startDate)}
                </span>
                <MiniSwitch
                  checked={season.watched}
                  label={`Mark season ${season.seasonNo} watched`}
                  onChange={(next) =>
                    void act(() => api.aniSetWatched(entry.id, season.seasonNo, next))
                  }
                />
              </div>
            ))}
          </div>

          <div className="ani-detail__foot">
            <label className="field" style={{ minWidth: 220 }}>
              <span>Anime category</span>
              <select
                className="select"
                value={entry.subdomainId ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  void act(
                    () =>
                      value
                        ? api.aniAssignEntry(entry.id, Number(value))
                        : api.aniUpdateEntry(entry.id, { clearCategory: true }),
                    "Category attached",
                  );
                }}
              >
                <option value="">Uncategorized</option>
                {workspace.aniDomains.map((domain) => (
                  <optgroup key={domain.id} label={domain.name}>
                    {domain.subdomains.map((subdomain) => (
                      <option key={subdomain.id} value={subdomain.id}>
                        {domain.name} / {subdomain.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            <label className="field" style={{ width: 130 }}>
              <span>Type</span>
              <select
                className="select"
                value={entry.animeType ?? "TV"}
                onChange={(event) =>
                  void act(() => api.aniUpdateEntry(entry.id, { animeType: event.target.value }))
                }
              >
                {["TV", "ONA", "OVA", "Movie", "Special", "Music"].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>

            <div className="field" style={{ flex: 1 }}>
              <span>Release notifications</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32 }}>
                <Switch
                  checked={entry.notifyRelease}
                  label={`Release notifications for ${entry.title}`}
                  onChange={(next) =>
                    void act(() => api.aniUpdateEntry(entry.id, { notifyRelease: next }))
                  }
                />
                <span style={{ fontSize: 11, color: "var(--faint)" }}>
                  {entry.notifyEnabled ? "Delivering" : "Muted by scope, label or switch"}
                </span>
              </div>
            </div>

            <button
              className="btn btn--sm btn--ghost"
              onClick={() => void act(() => api.aniDeleteEntry(entry.id), "Removed")}
            >
              Remove entry
            </button>
          </div>
        </div>
      )}
    </>
  );
}
