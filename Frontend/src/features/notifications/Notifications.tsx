import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowUpRight,
  BellOff,
  Check,
  CheckCheck,
  Filter,
  Radio,
  RefreshCw,
  Search,
} from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState, Thumb } from "../../app/ui";
import { formatAiring, formatDate, timeAgo } from "../../lib/format";
import type { AniEvent, YtKind, YtVideo } from "../../lib/types";

type Source = "youtube" | "anime";

const MODE_LABEL: Record<YtKind, string> = {
  tracking: "Track",
  wordscan: "WordScan",
  playlist: "Playlist",
  random: "Random",
};

type Row =
  | { kind: "yt"; id: number; at: number; video: YtVideo }
  | { kind: "ani"; id: number; at: number; event: AniEvent };

export default function Notifications() {
  const workspace = useWorkspace();
  const { act, refresh, refreshing } = useApp();
  const [, navigate] = useLocation();
  const [refreshingLocal, setRefreshingLocal] = useState(false);
  const isRefreshing = refreshing || refreshingLocal;

  const [source, setSource] = useState<Source>("youtube");
  const [mode, setMode] = useState<"all" | YtKind>("all");
  const [group, setGroup] = useState<"all" | "release" | "change">("all");
  const [bucket, setBucket] = useState<"all" | "today" | "sequel" | "new">("all");
  const [domain, setDomain] = useState<string | null>(null);
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [mutedOnly, setMutedOnly] = useState(false);

  const ytRows = useMemo<Row[]>(
    () =>
      workspace.ytFeed.map((video) => ({
        kind: "yt" as const,
        id: video.id,
        at: (video.publishedAt ?? 0) * 1000,
        video,
      })),
    [workspace.ytFeed],
  );

  const aniRows = useMemo<Row[]>(
    () =>
      workspace.aniEvents.map((event) => ({
        kind: "ani" as const,
        id: event.id,
        at: Date.parse(event.createdAt) || 0,
        event,
      })),
    [workspace.aniEvents],
  );

  const sourceRows = source === "youtube" ? ytRows : aniRows;

  const scoped = useMemo(() => {
    return sourceRows.filter((row) => {
      const rowDomain = row.kind === "yt" ? row.video.domain : row.event.domain;
      const rowSub = row.kind === "yt" ? row.video.subdomain : row.event.subdomain;
      if (domain && rowDomain !== domain) return false;
      if (subdomain && rowSub !== subdomain) return false;
      return true;
    });
  }, [domain, sourceRows, subdomain]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scoped
      .filter((row) => {
        if (row.kind === "yt") {
          if (mode !== "all" && row.video.mode !== mode) return false;
          if (unreadOnly && row.video.seen) return false;
          if (mutedOnly && row.video.notifyEnabled) return false;
          if (
            query &&
            !`${row.video.title} ${row.video.channel} ${row.video.domain} ${row.video.subdomain}`
              .toLowerCase()
              .includes(query)
          )
            return false;
          return true;
        }
        if (group !== "all" && row.event.group !== group) return false;
        if (bucket !== "all" && row.event.bucket !== bucket) return false;
        if (unreadOnly && row.event.seen) return false;
        if (mutedOnly && row.event.notifyEnabled) return false;
        if (
          query &&
          !`${row.event.title} ${row.event.label} ${row.event.domain} ${row.event.subdomain}`
            .toLowerCase()
            .includes(query)
        )
          return false;
        return true;
      })
      .sort((a, b) => b.at - a.at);
  }, [bucket, group, mode, mutedOnly, search, scoped, unreadOnly]);

  const unreadVisible = filtered.filter((row) =>
    row.kind === "yt" ? !row.video.seen : !row.event.seen,
  );

  const modeCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: scoped.length,
      tracking: 0,
      wordscan: 0,
      playlist: 0,
      random: 0,
    };
    for (const row of scoped) if (row.kind === "yt") counts[row.video.mode] += 1;
    return counts;
  }, [scoped]);

  const eventCounts = useMemo(() => {
    const counts = { all: scoped.length, release: 0, change: 0, today: 0, sequel: 0, new: 0 };
    for (const row of scoped) {
      if (row.kind !== "ani") continue;
      counts[row.event.group] += 1;
      counts[row.event.bucket] += 1;
    }
    return counts;
  }, [scoped]);

  const domainTree = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        muted: boolean;
        count: number;
        subs: Map<string, { count: number; muted: boolean }>;
      }
    >();
    for (const row of sourceRows) {
      const d = row.kind === "yt" ? row.video.domain : row.event.domain;
      const s = row.kind === "yt" ? row.video.subdomain : row.event.subdomain;
      const muted = row.kind === "yt" ? !row.video.notifyEnabled : !row.event.notifyEnabled;
      const entry = map.get(d) ?? { name: d, muted: false, count: 0, subs: new Map() };
      entry.count += 1;
      entry.muted = entry.muted || !muted ? entry.muted : entry.muted;
      const sub = entry.subs.get(s) ?? { count: 0, muted: false };
      sub.count += 1;
      sub.muted = sub.muted || muted;
      entry.subs.set(s, sub);
      map.set(d, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [sourceRows]);

  const mutedCount = scoped.filter((row) =>
    row.kind === "yt" ? !row.video.notifyEnabled : !row.event.notifyEnabled,
  ).length;

  const unreadCount = scoped.filter((row) =>
    row.kind === "yt" ? !row.video.seen : !row.event.seen,
  ).length;

  const markAllVisible = async () => {
    const videoIds = unreadVisible
      .filter((row): row is Extract<Row, { kind: "yt" }> => row.kind === "yt")
      .map((row) => row.video.id);
    const eventIds = unreadVisible
      .filter((row): row is Extract<Row, { kind: "ani" }> => row.kind === "ani")
      .map((row) => row.event.id);
    await act(async () => {
      if (videoIds.length) await api.ytMarkSeen(videoIds, true);
      if (eventIds.length) await api.aniEventsSeen(eventIds, true);
    });
  };

  const toggleRow = async (row: Row) => {
    if (row.kind === "yt") await act(() => api.ytMarkSeen([row.video.id], !row.video.seen));
    else await act(() => api.aniEventsSeen([row.event.id], !row.event.seen));
  };

  const openRow = (row: Row) => {
    if (row.kind === "yt") {
      if (row.video.url) window.open(row.video.url, "_blank", "noopener");
      if (!row.video.seen) void act(() => api.ytMarkSeen([row.video.id], true));
      return;
    }
    if (!row.event.seen) void act(() => api.aniEventsSeen([row.event.id], true));
    navigate(`/todo?entry=${row.event.entryId}`);
  };

  const handleRefresh = async () => {
    setRefreshingLocal(true);
    try {
      await Promise.all([
        refresh(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 300)),
      ]);
    } finally {
      setRefreshingLocal(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1>Notifications</h1>
          <p>Pull feed from tracked sources — seen state syncs through GraphQL.</p>
        </div>
        <div className="page-head__actions">
          <div className="metrics">
            <span>
              <b>{filtered.length}</b> shown
            </span>
            <span className="sep" />
            <span>
              <b>{unreadVisible.length}</b> unread
            </span>
            <span className="sep" />
            <span>
              <b>{mutedCount}</b> muted
            </span>
          </div>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => void handleRefresh()}
            title={isRefreshing ? "Refreshing notifications" : "Refresh notifications"}
            disabled={isRefreshing}
          >
            <RefreshCw size={13} className={isRefreshing ? "spin" : undefined} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="btn btn--sm"
            disabled={!unreadVisible.length}
            onClick={() => void markAllVisible()}
          >
            <CheckCheck size={14} /> Mark visible read
          </button>
        </div>
      </div>

      {isRefreshing && <div className="refresh-progress" role="status" aria-label="Refreshing notifications" />}

      <div className="notif-layout">
        <div className="notif-main">
          <div className="filterbar">
            <div className="segmented" style={{ marginRight: 4 }}>
              <button
                aria-pressed={source === "youtube"}
                className="is-yt"
                onClick={() => {
                  setSource("youtube");
                  setDomain(null);
                  setSubdomain(null);
                }}
              >
                YouTube <span style={{ opacity: 0.6 }}>{ytRows.length}</span>
              </button>
              <button
                aria-pressed={source === "anime"}
                className="is-ani"
                onClick={() => {
                  setSource("anime");
                  setDomain(null);
                  setSubdomain(null);
                }}
              >
                Anime <span style={{ opacity: 0.6 }}>{aniRows.length}</span>
              </button>
            </div>

            {source === "youtube"
              ? (["all", "tracking", "wordscan", "playlist", "random"] as const).map((value) => (
                  <button
                    key={value}
                    className="chipbtn"
                    data-active={mode === value}
                    onClick={() => setMode(value)}
                  >
                    {value === "all" ? "All types" : MODE_LABEL[value]}
                    <span className="count">{modeCounts[value] ?? 0}</span>
                  </button>
                ))
              : null}

            {source === "anime" ? (
              <>
                <button
                  className="chipbtn"
                  data-active={group === "all"}
                  onClick={() => setGroup("all")}
                >
                  All <span className="count">{eventCounts.all}</span>
                </button>
                <button
                  className="chipbtn"
                  data-active={group === "release"}
                  onClick={() => setGroup("release")}
                >
                  Release <span className="count">{eventCounts.release}</span>
                </button>
                <button
                  className="chipbtn"
                  data-active={group === "change"}
                  onClick={() => setGroup("change")}
                >
                  Change <span className="count">{eventCounts.change}</span>
                </button>
                <span
                  style={{ width: 1, height: 16, background: "var(--line)", margin: "0 4px" }}
                />
                {(["all", "today", "sequel", "new"] as const).map((value) => (
                  <button
                    key={value}
                    className="chipbtn"
                    data-active={bucket === value}
                    onClick={() => setBucket(value)}
                    disabled={group === "change" && value === "new"}
                  >
                    {value === "all"
                      ? "Any date"
                      : value === "today"
                        ? "Today"
                        : value === "sequel"
                          ? "Sequel"
                          : "New"}
                  </button>
                ))}
              </>
            ) : null}

            <button
              className="chipbtn"
              data-active={unreadOnly}
              onClick={() => setUnreadOnly((value) => !value)}
              title="Only unread"
            >
              Unread
            </button>
            <button
              className="chipbtn"
              data-active={mutedOnly}
              onClick={() => setMutedOnly((value) => !value)}
              title="Only muted sources"
            >
              <BellOff size={12} /> Muted
            </button>

            <label className="search">
              <Search size={13} />
              <input
                className="input"
                data-search
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search feed  /"
              />
            </label>
          </div>

          <div className="feed">
            {filtered.length === 0 && (
              <EmptyState
                title="Nothing matches this view"
                hint="Adjust the type, category, or search filters."
                icon={<Filter size={20} />}
              />
            )}
            {filtered.map((row) =>
              row.kind === "yt" ? (
                <YtRow
                  key={`yt-${row.video.id}`}
                  video={row.video}
                  onOpen={() => openRow(row)}
                  onToggle={() => void toggleRow(row)}
                />
              ) : (
                <AniRow
                  key={`ani-${row.event.id}`}
                  event={row.event}
                  onOpen={() => openRow(row)}
                  onToggle={() => void toggleRow(row)}
                />
              ),
            )}
          </div>
        </div>

        <aside className="notif-side">
          <section className="side-card">
            <div className="side-card__head">
              <h3>Delivery map</h3>
              <span>domain / subdomain</span>
            </div>
            <div
              className="tree-row"
              data-active={!domain}
              onClick={() => {
                setDomain(null);
                setSubdomain(null);
              }}
            >
              <Radio size={12} /> All categories
              <span className="count">{sourceRows.length}</span>
            </div>
            {domainTree.map((entry) => (
              <div key={entry.name}>
                <div
                  className="tree-row"
                  data-active={domain === entry.name && !subdomain}
                  onClick={() => {
                    setDomain(entry.name);
                    setSubdomain(null);
                  }}
                >
                  <span className="dot" style={{ color: "var(--faint)" }} />
                  <span className={entry.muted ? "tree-muted" : undefined}>{entry.name}</span>
                  <span className="count">{entry.count}</span>
                </div>
                {[...entry.subs.entries()].map(([name, sub]) => (
                  <div
                    key={name}
                    className="tree-row tree-sub"
                    data-active={domain === entry.name && subdomain === name}
                    onClick={() => {
                      setDomain(entry.name);
                      setSubdomain(name);
                    }}
                  >
                    <span
                      className={`dot`}
                      style={{ color: sub.muted ? "var(--faint)" : "var(--accent)" }}
                    />
                    <span className={sub.muted ? "tree-muted" : undefined}>{name}</span>
                    <span className="count">{sub.count}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>

          <section className="side-card">
            <div className="side-card__head">
              <h3>{source === "youtube" ? "Notification types" : "Event mix"}</h3>
              <span>{scoped.length} events</span>
            </div>
            <div className="type-bars">
              {source === "youtube"
                ? (["tracking", "wordscan", "playlist", "random"] as const).map((key) => (
                    <TypeBar
                      key={key}
                      label={MODE_LABEL[key]}
                      value={modeCounts[key] ?? 0}
                      total={modeCounts.all}
                    />
                  ))
                : [
                    ["Release", eventCounts.release],
                    ["Change", eventCounts.change],
                    ["Today", eventCounts.today],
                    ["Sequel", eventCounts.sequel],
                  ].map(([label, value]) => (
                    <TypeBar
                      key={String(label)}
                      label={String(label)}
                      value={Number(value)}
                      total={eventCounts.all}
                      accent="var(--ani)"
                    />
                  ))}
            </div>
          </section>

          <section className="side-card">
            <div className="side-card__head">
              <h3>Scopes</h3>
              <span>delivery gate</span>
            </div>
            <div style={{ display: "grid", gap: 7, fontSize: 11, color: "var(--faint)" }}>
              <span>
                <b style={{ color: "var(--dim)" }}>Domain</b> mutes everything below it.
              </span>
              <span>
                <b style={{ color: "var(--dim)" }}>Subdomain</b> mutes its channels only.
              </span>
              <span>
                <b style={{ color: "var(--dim)" }}>Channel</b> mutes a single source.
              </span>
              <span style={{ color: "var(--dim)" }}>Effective = domain ∧ subdomain ∧ channel.</span>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TypeBar({
  label,
  value,
  total,
  accent,
}: {
  label: string;
  value: number;
  total: number;
  accent?: string;
}) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="type-bar">
      <div className="type-bar__label">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="type-bar__track">
        <span
          className="type-bar__fill"
          style={{ width: `${pct}%`, background: accent ?? "var(--accent)" }}
        />
      </div>
    </div>
  );
}

function YtRow({
  video,
  onOpen,
  onToggle,
}: {
  video: YtVideo;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className="feed-row"
      data-unread={!video.seen}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <span className="feed-row__bar" />
      <Thumb src={video.thumbnail} alt={video.title ?? "Video"} />
      <div className="feed-copy">
        <div className="feed-top">
          <strong>{video.channel ?? "Unknown channel"}</strong>
          <span className="dot-sep" />
          <span>{timeAgo(video.publishedAt)}</span>
          {video.label === "blocked" && <span className="chip chip--danger">blocked</span>}
        </div>
        <div className="feed-title">{video.title}</div>
        <div className="feed-sub">
          <span className="feed-cat">
            {video.domain}
            <i>/</i>
            {video.subdomain}
          </span>
          <span className="mode-tag" data-mode={video.mode}>
            {MODE_LABEL[video.mode]}
          </span>
          {!video.notifyEnabled && (
            <span className="chip chip--muted">
              <BellOff size={9} /> muted
            </span>
          )}
        </div>
      </div>
      <div className="feed-side">
        <div className="feed-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="icon-btn"
            title={video.seen ? "Mark unread" : "Mark read"}
            aria-label={video.seen ? "Mark unread" : "Mark read"}
            onClick={onToggle}
          >
            <Check size={13} />
          </button>
          <button
            className="icon-btn"
            title="Open on YouTube"
            aria-label="Open on YouTube"
            onClick={() => video.url && window.open(video.url, "_blank", "noopener")}
          >
            <ArrowUpRight size={13} />
          </button>
        </div>
        {!video.seen && <span className="dot" style={{ color: "var(--accent)" }} />}
      </div>
    </div>
  );
}

function AniRow({
  event,
  onOpen,
  onToggle,
}: {
  event: AniEvent;
  onOpen: () => void;
  onToggle: () => void;
}) {
  let detail: string | null = null;
  try {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    if (payload.release) detail = `Release ${formatDate(String(payload.release))}`;
    else if (payload.airing_at)
      detail = formatAiring(Number(payload.airing_at), Number(payload.episode));
    else if (payload.now) detail = `Moved to ${formatDate(String(payload.now))}`;
    else if (payload.new) detail = `Moved to ${formatDate(String(payload.new))}`;
  } catch {
    detail = null;
  }

  return (
    <div
      className="feed-row"
      data-ani="true"
      data-unread={!event.seen}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <span className="feed-row__bar" />
      <Thumb
        src={event.cover}
        alt={event.title ?? "Anime"}
        className="feed-thumb feed-thumb--square"
      />
      <div className="feed-copy">
        <div className="feed-top">
          <strong>{event.title}</strong>
          <span className="dot-sep" />
          <span>{formatDate(event.createdAt)}</span>
          {event.seasonNo ? <span>· S{event.seasonNo}</span> : null}
        </div>
        <div className="feed-title">{event.label}</div>
        <div className="feed-sub">
          <span className="feed-cat">
            {event.domain}
            <i>/</i>
            {event.subdomain}
          </span>
          <span className={`chip ${event.group === "change" ? "chip--warn" : "chip--ani"}`}>
            {event.group === "release" ? "Release" : "Change"} ·{" "}
            {event.bucket === "today" ? "Today" : event.bucket === "sequel" ? "Sequel" : "New"}
          </span>
          {detail && <span>{detail}</span>}
          {!event.notifyEnabled && (
            <span className="chip chip--muted">
              <BellOff size={9} /> muted
            </span>
          )}
        </div>
      </div>
      <div className="feed-side">
        <div className="feed-actions" onClick={(event_) => event_.stopPropagation()}>
          <button
            className="icon-btn"
            aria-label={event.seen ? "Mark unread" : "Mark read"}
            onClick={onToggle}
          >
            <Check size={13} />
          </button>
        </div>
        {!event.seen && <span className="dot" style={{ color: "var(--accent)" }} />}
      </div>
    </div>
  );
}
