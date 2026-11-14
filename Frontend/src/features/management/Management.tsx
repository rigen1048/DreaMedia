import { useState } from "react";
import { Ban, FolderTree, Plus, Search, Tv, Undo2 } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { EmptyState } from "../../app/ui";
import AnimeTab from "./AnimeTab";
import Categories from "./Categories";
import Channels from "./Channels";
import { AddAnimeDialog, AddSourceDialog } from "./Dialogs";

const TABS = [
  { key: "channels", label: "Channels", icon: Tv },
  { key: "categories", label: "Categories", icon: FolderTree },
  { key: "anime", label: "Anime", icon: null },
  { key: "blocked", label: "Blocked", icon: Ban },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function Management() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<TabKey>("channels");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "muted" | "inactive">("all");
  const [animeList, setAnimeList] = useState("all");
  const [dialog, setDialog] = useState<"source" | "anime" | null>(null);

  const muted =
    workspace.ytChannels.filter((channel) => !channel.notifyEnabled && channel.label !== "blocked")
      .length +
    workspace.aniEntries.filter((entry) => !entry.notifyEnabled && entry.label !== "blocked")
      .length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__title">
          <h1>Management</h1>
          <p>Sources, categories and anime metadata — one GraphQL schema, one source of truth.</p>
        </div>
        <div className="page-head__actions">
          <div className="metrics">
            <span>
              <b>{workspace.ytChannels.length}</b> sources
            </span>
            <span className="sep" />
            <span>
              <b>{workspace.ytDomains.length + workspace.aniDomains.length}</b> categories
            </span>
            <span className="sep" />
            <span>
              <b>{workspace.aniEntries.length}</b> anime
            </span>
            <span className="sep" />
            <span>
              <b>{muted}</b> muted
            </span>
          </div>
        </div>
      </div>

      <div className="mgmt-bar">
        <div className="segmented">
          {TABS.map((item) => (
            <button key={item.key} data-active={tab === item.key} onClick={() => setTab(item.key)}>
              {item.label}
            </button>
          ))}
        </div>

        <div className="search">
          <Search size={13} />
          <input
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tab === "anime" ? "Search anime" : "Search sources and categories"}
            aria-label="Search management"
          />
        </div>

        {tab === "channels" && (
          <select
            className="select"
            style={{ height: 30, width: 130 }}
            value={scope}
            aria-label="Filter channels"
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            <option value="all">All sources</option>
            <option value="muted">Muted only</option>
            <option value="inactive">Paused only</option>
          </select>
        )}

        <span className="grow" />

        {tab === "channels" && (
          <button className="btn btn--sm btn--primary" onClick={() => setDialog("source")}>
            <Plus size={13} /> Add source
          </button>
        )}
        {tab === "anime" && (
          <button className="btn btn--sm btn--primary" onClick={() => setDialog("anime")}>
            <Plus size={13} /> Track anime
          </button>
        )}
      </div>

      {tab === "channels" && (
        <Channels search={search} filter={scope} onAdd={() => setDialog("source")} />
      )}
      {tab === "categories" && <Categories />}
      {tab === "anime" && (
        <AnimeTab
          search={search}
          list={animeList}
          onList={setAnimeList}
          onAdd={() => setDialog("anime")}
        />
      )}
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
    <div style={{ display: "grid", gap: 18 }}>
      <section>
        <div className="section-head">
          <h2>Blocked sources</h2>
          <span>Blocked sources never notify and stay out of the feed filters.</span>
        </div>
        <div className="table">
          {channels.length === 0 ? (
            <EmptyState
              title="No blocked sources"
              hint="Use a channel's label selector to block it."
            />
          ) : (
            channels.map((channel) => (
              <div
                className="ch-row"
                key={channel.id}
                style={{ gridTemplateColumns: "1fr 140px 100px" }}
              >
                <div className="src">
                  {channel.logo ? (
                    <img
                      className="src__logo"
                      src={channel.logo}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="src__logo src__logo--fallback">
                      {(channel.name ?? "?").slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <div>
                    <div className="src__name">{channel.name}</div>
                    <div className="src__url">
                      {channel.domain} / {channel.subdomain}
                    </div>
                  </div>
                </div>
                <span className="chip chip--danger">
                  <Ban size={9} /> blocked
                </span>
                <button
                  className="btn btn--sm"
                  onClick={() =>
                    void act(() => api.ytSetLabel(channel.id, "none"), "Channel unblocked")
                  }
                >
                  <Undo2 size={12} /> Unblock
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Blocked anime</h2>
          <span>Release and change notifications are suppressed.</span>
        </div>
        <div className="table">
          {anime.length === 0 ? (
            <EmptyState title="No blocked anime" hint="Set an anime entry's state to Blocked." />
          ) : (
            anime.map((entry) => (
              <div
                className="ch-row"
                key={entry.id}
                style={{ gridTemplateColumns: "1fr 140px 100px" }}
              >
                <div className="src">
                  {entry.cover ? (
                    <img
                      className="src__logo"
                      src={entry.cover}
                      alt=""
                      referrerPolicy="no-referrer"
                      style={{ borderRadius: 6 }}
                    />
                  ) : (
                    <span className="src__logo src__logo--fallback">
                      {(entry.title ?? "?").slice(0, 1)}
                    </span>
                  )}
                  <div>
                    <div className="src__name">{entry.title}</div>
                    <div className="src__url">
                      {entry.domain} / {entry.subdomain}
                    </div>
                  </div>
                </div>
                <span className="chip chip--danger">
                  <Ban size={9} /> blocked
                </span>
                <button
                  className="btn btn--sm"
                  onClick={() =>
                    void act(
                      () => api.aniUpdateEntry(entry.id, { label: "none" }),
                      "Anime unblocked",
                    )
                  }
                >
                  <Undo2 size={12} /> Unblock
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
