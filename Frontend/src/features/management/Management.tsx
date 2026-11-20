import { useState } from "react";
import { Ban, FolderTree, Plus, RefreshCw, Search, Tv, Undo2 } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState } from "../../app/ui";
import AnimeTab from "./AnimeTab";
import Categories from "./Categories";
import Channels from "./Channels";
import { AddAnimeDialog, AddSourceDialog } from "./Dialogs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const TABS = [
  { key: "anime", label: "Anime", icon: null },
  { key: "channels", label: "Channels", icon: Tv },
  { key: "categories", label: "Categories", icon: FolderTree },
  { key: "blocked", label: "Blocked", icon: Ban },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function Management() {
  const workspace = useWorkspace();
  const { notify, refresh } = useApp();
  const [tab, setTab] = useState<TabKey>("channels");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "muted" | "inactive">("all");
  const [animeList, setAnimeList] = useState("all");
  const [dialog, setDialog] = useState<"source" | "anime" | null>(null);
  const [fetching, setFetching] = useState(false);

  const fetchNow = async () => {
    setFetching(true);
    try {
      const result = await api.ytFetchNow();
      await refresh();
      notify(
        result.ytFetchNow
          ? `Fetching ${result.ytFetchNow} source${result.ytFetchNow === 1 ? "" : "s"} now — new uploads land in Notifications`
          : "Nothing to fetch — add a source first",
        result.ytFetchNow ? "ok" : "info",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Fetch failed", "error");
    } finally {
      setFetching(false);
    }
  };

  const muted =
    workspace.ytChannels.filter((channel) => !channel.notifyEnabled && channel.label !== "blocked").length +
    workspace.aniEntries.filter((entry) => !entry.notifyEnabled && entry.label !== "blocked").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Management</h1>
          <p className="text-xs text-muted-foreground">Sources, categories and anime metadata — one GraphQL schema, one source of truth.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <b className="text-foreground">{workspace.ytChannels.length}</b> sources ·{" "}
          <b className="text-foreground">{workspace.ytDomains.length + workspace.aniDomains.length}</b> categories ·{" "}
          <b className="text-foreground">{workspace.aniEntries.length}</b> anime ·{" "}
          <b className="text-foreground">{muted}</b> muted
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg bg-muted p-1">
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors cursor-pointer",
                tab === item.key ? "bg-background shadow" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tab === "anime" ? "Search anime" : "Search sources and categories"}
            aria-label="Search management"
            className="h-8 w-56 pl-7"
          />
        </div>

        {tab === "channels" && (
          <Select value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
            <SelectTrigger className="h-8 w-36" aria-label="Filter channels">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="muted">Muted only</SelectItem>
              <SelectItem value="inactive">Paused only</SelectItem>
            </SelectContent>
          </Select>
        )}

        <span className="grow" />

        {tab === "channels" && (
          <>
            <Button variant="secondary" size="sm" onClick={() => void fetchNow()} disabled={fetching}
              title="Check every active source right now instead of waiting for the next poll">
              <RefreshCw size={13} className={fetching ? "animate-spin" : undefined} />
              {fetching ? "Fetching…" : "Fetch now"}
            </Button>
            <Button size="sm" onClick={() => setDialog("source")}>
              <Plus size={13} /> Add source
            </Button>
          </>
        )}
        {tab === "anime" && (
          <Button size="sm" onClick={() => setDialog("anime")}>
            <Plus size={13} /> Track anime
          </Button>
        )}
      </div>

      {tab === "channels" && <Channels search={search} filter={scope} onAdd={() => setDialog("source")} />}
      {tab === "categories" && <Categories />}
      {tab === "anime" && <AnimeTab search={search} list={animeList} onList={setAnimeList} onAdd={() => setDialog("anime")} />}
      {tab === "blocked" && <Blocked />}

      {dialog === "source" && <AddSourceDialog onClose={() => setDialog(null)} />}
      {dialog === "anime" && <AddAnimeDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function Blocked() {
  const workspace = useWorkspace();
  const { act } = useApp();

  const channels = workspace.ytChannels.filter((channel) => channel.label === "blocked");
  const anime = workspace.aniEntries.filter((entry) => entry.label === "blocked");

  return (
    <div className="grid gap-6">
      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Blocked sources</h2>
          <p className="text-xs text-muted-foreground">Blocked sources never notify and stay out of the feed filters.</p>
        </div>
        {channels.length === 0 ? (
          <EmptyState title="No blocked sources" hint="Use a channel's label selector to block it." />
        ) : (
          <div className="space-y-1.5">
            {channels.map((channel) => (
              <div key={channel.id} className="flex items-center gap-3 rounded-xl border bg-card p-3">
                {channel.logo ? (
                  <img className="h-9 w-9 rounded-full object-cover" src={channel.logo} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-xs font-bold">
                    {(channel.name ?? "?").slice(0, 2).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{channel.name}</div>
                  <div className="text-xs text-muted-foreground">{channel.domain} / {channel.subdomain}</div>
                </div>
                <Badge variant="destructive" className="gap-1"><Ban size={9} /> blocked</Badge>
                <Button size="sm" variant="secondary" onClick={() => void act(() => api.ytSetLabel(channel.id, "none"), "Channel unblocked")}>
                  <Undo2 size={12} /> Unblock
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Blocked anime</h2>
          <p className="text-xs text-muted-foreground">Release and change notifications are suppressed.</p>
        </div>
        {anime.length === 0 ? (
          <EmptyState title="No blocked anime" hint="Set an anime entry's state to Blocked." />
        ) : (
          <div className="space-y-1.5">
            {anime.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 rounded-xl border bg-card p-3">
                {entry.cover ? (
                  <img className="h-11 w-9 rounded-md object-cover" src={entry.cover} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="flex h-11 w-9 items-center justify-center rounded-md bg-secondary text-xs font-bold">
                    {(entry.title ?? "?").slice(0, 1)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{entry.title}</div>
                  <div className="text-xs text-muted-foreground">{entry.domain} / {entry.subdomain}</div>
                </div>
                <Badge variant="destructive" className="gap-1"><Ban size={9} /> blocked</Badge>
                <Button size="sm" variant="secondary" onClick={() => void act(() => api.aniUpdateEntry(entry.id, { label: "none" }), "Anime unblocked")}>
                  <Undo2 size={12} /> Unblock
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
