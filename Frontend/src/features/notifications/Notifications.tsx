import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowUpRight, BellOff, Check, CheckCheck, Filter, Radio, RefreshCw, Search,
} from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState, Thumb } from "../../app/ui";
import { formatAiring, formatDate, timeAgo } from "../../lib/format";
import type { AniEvent, YtKind, YtVideo } from "../../lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Source = "youtube" | "anime";

const MODE_LABEL: Record<YtKind, string> = {
  tracking: "Track", wordscan: "WordScan", playlist: "Playlist", random: "Random",
};

type Row =
  | { kind: "yt"; id: number; at: number; video: YtVideo }
  | { kind: "ani"; id: number; at: number; event: AniEvent };

function Chip({
  active, onClick, disabled, children,
}: { active?: boolean; onClick?: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
        active ? "bg-primary text-primary-foreground border-transparent" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

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

  const ytRows = useMemo<Row[]>(
    () => workspace.ytFeed.map((video) => ({ kind: "yt" as const, id: video.id, at: (video.publishedAt ?? 0) * 1000, video })),
    [workspace.ytFeed],
  );
  const aniRows = useMemo<Row[]>(
    () => workspace.aniEvents.map((event) => ({ kind: "ani" as const, id: event.id, at: Date.parse(event.createdAt) || 0, event })),
    [workspace.aniEvents],
  );
  const sourceRows = source === "youtube" ? ytRows : aniRows;

  const scoped = useMemo(
    () =>
      sourceRows.filter((row) => {
        const rowDomain = row.kind === "yt" ? row.video.domain : row.event.domain;
        const rowSub = row.kind === "yt" ? row.video.subdomain : row.event.subdomain;
        if (domain && rowDomain !== domain) return false;
        if (subdomain && rowSub !== subdomain) return false;
        return true;
      }),
    [domain, sourceRows, subdomain],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scoped
      .filter((row) => {
        if (row.kind === "yt") {
          if (mode !== "all" && row.video.mode !== mode) return false;
          if (query && !`${row.video.title} ${row.video.channel} ${row.video.domain} ${row.video.subdomain}`.toLowerCase().includes(query)) return false;
          return true;
        }
        if (group !== "all" && row.event.group !== group) return false;
        if (bucket !== "all" && row.event.bucket !== bucket) return false;
        if (query && !`${row.event.title} ${row.event.label} ${row.event.domain} ${row.event.subdomain}`.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => {
        // P5: serialize the feed so everything from one channel stays together
        // (domain → subdomain → channel), newest-first within a channel,
        // instead of a pure time sort that interleaves channels.
        const aKey = [
          a.kind === "yt" ? a.video.domain : a.event.domain,
          a.kind === "yt" ? a.video.subdomain : a.event.subdomain,
          a.kind === "yt" ? a.video.channel : a.event.title,
        ];
        const bKey = [
          b.kind === "yt" ? b.video.domain : b.event.domain,
          b.kind === "yt" ? b.video.subdomain : b.event.subdomain,
          b.kind === "yt" ? b.video.channel : b.event.title,
        ];
        for (let i = 0; i < 3; i++) {
          const c = String(aKey[i] ?? "").localeCompare(String(bKey[i] ?? ""));
          if (c !== 0) return c;
        }
        return b.at - a.at;
      })
  }, [bucket, group, mode, search, scoped]);

  const unreadVisible = filtered.filter((row) => (row.kind === "yt" ? !row.video.seen : !row.event.seen));

  const modeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: scoped.length, tracking: 0, wordscan: 0, playlist: 0, random: 0 };
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
    const map = new Map<string, { name: string; muted: boolean; count: number; subs: Map<string, { count: number; muted: boolean }> }>();
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

  const markAllVisible = async () => {
    const videoIds = unreadVisible.filter((row): row is Extract<Row, { kind: "yt" }> => row.kind === "yt").map((row) => row.video.id);
    const eventIds = unreadVisible.filter((row): row is Extract<Row, { kind: "ani" }> => row.kind === "ani").map((row) => row.event.id);
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
    // D57: opening a notification sends it to the trashbin (24h purge window).
    if (row.kind === "yt") {
      if (row.video.url) window.open(row.video.url, "_blank", "noopener");
      void act(() => api.ytTrashVideos([row.video.id]));
      return;
    }
    void act(() => api.aniTrashEvents([row.event.id]));
    navigate(`/todo?entry=${row.event.entryId}`);
  };

  const handleRefresh = async () => {
    setRefreshingLocal(true);
    try {
      await Promise.all([refresh(), new Promise<void>((resolve) => window.setTimeout(resolve, 300))]);
    } finally {
      setRefreshingLocal(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Head */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Notifications</h1>
          <p className="text-xs text-muted-foreground">Pull feed from tracked sources — seen state syncs through GraphQL.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span><b className="text-foreground">{filtered.length}</b> shown</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void handleRefresh()} disabled={isRefreshing}>
            <RefreshCw size={13} className={isRefreshing ? "animate-spin" : undefined} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button size="sm" disabled={!unreadVisible.length} onClick={() => void markAllVisible()}>
            <CheckCheck size={14} /> Mark visible read
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
        {/* Main column */}
        <div className="space-y-3 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="mr-1 inline-flex rounded-lg bg-muted p-1">
              {(["youtube", "anime"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => { setSource(s); setDomain(null); setSubdomain(null); }}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm font-medium transition-colors cursor-pointer",
                    source === s ? "bg-background shadow" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s === "youtube" ? "YouTube" : "Anime"}{" "}
                  <span className="opacity-60">{s === "youtube" ? ytRows.length : aniRows.length}</span>
                </button>
              ))}
            </div>

            {source === "youtube" &&
              (["all", "tracking", "wordscan", "playlist", "random"] as const).map((value) => (
                <Chip key={value} active={mode === value} onClick={() => setMode(value)}>
                  {value === "all" ? "All types" : MODE_LABEL[value]}
                  <span className="opacity-60">{modeCounts[value] ?? 0}</span>
                </Chip>
              ))}

            {source === "anime" && (
              <>
                <Chip active={group === "all"} onClick={() => setGroup("all")}>All <span className="opacity-60">{eventCounts.all}</span></Chip>
                <Chip active={group === "release"} onClick={() => setGroup("release")}>Release <span className="opacity-60">{eventCounts.release}</span></Chip>
                <Chip active={group === "change"} onClick={() => setGroup("change")}>Change <span className="opacity-60">{eventCounts.change}</span></Chip>
                <span className="mx-1 h-4 w-px bg-border" />
                {(["all", "today", "sequel", "new"] as const).map((value) => (
                  <Chip key={value} active={bucket === value} onClick={() => setBucket(value)} disabled={group === "change" && value === "new"}>
                    {value === "all" ? "Any date" : value === "today" ? "Today" : value === "sequel" ? "Sequel" : "New"}
                  </Chip>
                ))}
              </>
            )}

            <div className="relative ml-auto">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                data-search
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search feed  /"
                className="h-8 w-52 pl-7"
              />
            </div>
          </div>

          {/* Feed */}
          <div className="space-y-2">
            {filtered.length === 0 && (
              <EmptyState title="Nothing matches this view" hint="Adjust the type, category, or search filters." icon={<Filter size={20} />} />
            )}
            {filtered.map((row) =>
              row.kind === "yt" ? (
                <YtRow key={`yt-${row.video.id}`} video={row.video} onOpen={() => openRow(row)} onToggle={() => void toggleRow(row)} />
              ) : (
                <AniRow key={`ani-${row.event.id}`} event={row.event} onOpen={() => openRow(row)} onToggle={() => void toggleRow(row)} />
              ),
            )}
          </div>
        </div>

        {/* Side column */}
        <aside className="space-y-3">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Delivery map</CardTitle>
              <p className="text-xs text-muted-foreground">domain / subdomain</p>
            </CardHeader>
            <CardContent className="p-2">
              <TreeRow active={!domain} onClick={() => { setDomain(null); setSubdomain(null); }}>
                <Radio size={12} /> All categories
                <span className="ml-auto text-xs text-muted-foreground">{sourceRows.length}</span>
              </TreeRow>
              {domainTree.map((entry) => (
                <div key={entry.name}>
                  <TreeRow active={domain === entry.name && !subdomain} onClick={() => { setDomain(entry.name); setSubdomain(null); }}>
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                    <span className={entry.muted ? "line-through opacity-50" : undefined}>{entry.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{entry.count}</span>
                  </TreeRow>
                  {[...entry.subs.entries()].map(([name, sub]) => (
                    <TreeRow key={name} className="pl-7" active={domain === entry.name && subdomain === name} onClick={() => { setDomain(entry.name); setSubdomain(name); }}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", sub.muted ? "bg-muted-foreground" : "bg-sky-500")} />
                      <span className={sub.muted ? "line-through opacity-50" : undefined}>{name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{sub.count}</span>
                    </TreeRow>
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">{source === "youtube" ? "Notification types" : "Event mix"}</CardTitle>
              <p className="text-xs text-muted-foreground">{scoped.length} events</p>
            </CardHeader>
            <CardContent className="space-y-2.5 p-4 pt-0">
              {source === "youtube"
                ? (["tracking", "wordscan", "playlist", "random"] as const).map((key) => (
                    <TypeBar key={key} label={MODE_LABEL[key]} value={modeCounts[key] ?? 0} total={modeCounts.all} />
                  ))
                : ([["Release", eventCounts.release], ["Change", eventCounts.change], ["Today", eventCounts.today], ["Sequel", eventCounts.sequel]] as const).map(([label, value]) => (
                    <TypeBar key={label} label={label} value={value} total={eventCounts.all} accent="bg-violet-500" />
                  ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">Scopes</CardTitle>
              <p className="text-xs text-muted-foreground">delivery gate</p>
            </CardHeader>
            <CardContent className="grid gap-1.5 p-4 pt-0 text-xs text-muted-foreground">
              <span><b className="text-foreground/80">Domain</b> mutes everything below it.</span>
              <span><b className="text-foreground/80">Subdomain</b> mutes its channels only.</span>
              <span><b className="text-foreground/80">Channel</b> mutes a single source.</span>
              <span className="text-foreground/60">Effective = domain ∧ subdomain ∧ channel.</span>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function TreeRow({ active, onClick, className, children }: { active?: boolean; onClick?: () => void; className?: string; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
        active && "bg-accent font-medium",
        className,
      )}
    >
      {children}
    </div>
  );
}

function TypeBar({ label, value, total, accent }: { label: string; value: number; total: number; accent?: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full bg-sky-500 transition-all", accent)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function YtRow({ video, onOpen, onToggle }: { video: YtVideo; onOpen: () => void; onToggle: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-accent/50",
        !video.seen && "border-l-2 border-l-sky-500",
      )}
    >
      <Thumb src={video.thumbnail} alt={video.title ?? "Video"} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <strong className="text-foreground/90">{video.channel ?? "Unknown channel"}</strong>
          <span>·</span>
          <span>{timeAgo(video.publishedAt)}</span>
          {video.label === "blocked" && <Badge variant="destructive" className="text-[10px]">blocked</Badge>}
        </div>
        <div className="mt-0.5 truncate text-sm font-medium">{video.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{video.domain}<i className="not-italic opacity-50"> / </i>{video.subdomain}</span>
          <Badge variant="secondary" className="text-[10px]">{MODE_LABEL[video.mode]}</Badge>
          {!video.notifyEnabled && (
            <Badge variant="outline" className="gap-1 text-[10px]"><BellOff size={9} /> muted</Badge>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end justify-between" onClick={(event) => event.stopPropagation()}>
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="icon" className="h-7 w-7" title={video.seen ? "Mark unread" : "Mark read"} onClick={onToggle}>
            <Check size={13} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Open on YouTube" onClick={() => video.url && window.open(video.url, "_blank", "noopener")}>
            <ArrowUpRight size={13} />
          </Button>
        </div>
        {!video.seen && <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />}
      </div>
    </div>
  );
}

function AniRow({ event, onOpen, onToggle }: { event: AniEvent; onOpen: () => void; onToggle: () => void }) {
  let detail: string | null = null;
  try {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    if (payload.release) detail = `Release ${formatDate(String(payload.release))}`;
    else if (payload.airing_at) detail = formatAiring(Number(payload.airing_at), Number(payload.episode));
    else if (payload.now) detail = `Moved to ${formatDate(String(payload.now))}`;
    else if (payload.new) detail = `Moved to ${formatDate(String(payload.new))}`;
  } catch {
    detail = null;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-accent/50",
        !event.seen && "border-l-2 border-l-violet-500",
      )}
    >
      <Thumb src={event.cover} alt={event.title ?? "Anime"} className="aspect-square w-16 object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <strong className="text-foreground/90">{event.title}</strong>
          <span>·</span>
          <span>{formatDate(event.createdAt)}</span>
          {event.seasonNo ? <span>· S{event.seasonNo}</span> : null}
        </div>
        <div className="mt-0.5 truncate text-sm font-medium">{event.label}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{event.domain}<i className="not-italic opacity-50"> / </i>{event.subdomain}</span>
          <Badge variant={event.group === "change" ? "destructive" : "secondary"} className="text-[10px]">
            {event.group === "release" ? "Release" : "Change"} · {event.bucket === "today" ? "Today" : event.bucket === "sequel" ? "Sequel" : "New"}
          </Badge>
          {detail && <span>{detail}</span>}
          {!event.notifyEnabled && (
            <Badge variant="outline" className="gap-1 text-[10px]"><BellOff size={9} /> muted</Badge>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end justify-between" onClick={(e) => e.stopPropagation()}>
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={event.seen ? "Mark unread" : "Mark read"} onClick={onToggle}>
            <Check size={13} />
          </Button>
        </div>
        {!event.seen && <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />}
      </div>
    </div>
  );
}
