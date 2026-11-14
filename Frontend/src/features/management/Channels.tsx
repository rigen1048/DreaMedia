import { useMemo, useState } from "react";
import {
  BellOff,
  BellRing,
  ChevronDown,
  ExternalLink,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { ConfirmButton, EmptyState, Switch } from "../../app/ui";
import type { YtChannel, YtKind } from "../../lib/types";

const TYPE_LABEL: Record<YtKind, string> = {
  tracking: "Track",
  wordscan: "WordScan",
  playlist: "Playlist",
  random: "Random",
};

const FREQUENCIES = [
  ["day", "Daily"],
  ["tri_day", "Every 3 days"],
  ["week", "Weekly"],
  ["bi_week", "Every 2 weeks"],
  ["month", "Monthly"],
] as const;

type Props = {
  search: string;
  filter: "all" | "muted" | "inactive";
  onAdd: () => void;
};

export default function Channels({ search, filter, onAdd }: Props) {
  const { act } = useApp();
  const workspace = useWorkspace();
  const [openId, setOpenId] = useState<number | null>(null);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workspace.ytChannels
      .filter((channel) => channel.label !== "blocked")
      .filter((channel) => {
        if (filter === "muted") return !channel.notifyEnabled;
        if (filter === "inactive") return channel.active === false;
        return true;
      })
      .filter((channel) =>
        query
          ? `${channel.name} ${channel.url} ${channel.domain} ${channel.subdomain} ${channel.kind}`
              .toLowerCase()
              .includes(query)
          : true,
      );
  }, [filter, search, workspace.ytChannels]);

  if (!workspace.ytChannels.length) {
    return (
      <div className="table">
        <EmptyState
          title="No sources yet"
          hint="Add a YouTube channel or playlist link — the backend resolves it."
          action={
            <button className="btn btn--primary btn--sm" onClick={onAdd}>
              Add source
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="table">
      <div className="table__head">
        <span>Source</span>
        <span>Type</span>
        <span>Category</span>
        <span>Notify</span>
        <span>Status</span>
        <span style={{ textAlign: "right" }}>Open</span>
      </div>

      {rows.length === 0 && (
        <EmptyState title="No sources match" hint="Try clearing the search or filter." />
      )}

      {rows.map((channel) => (
        <ChannelRow
          key={channel.id}
          channel={channel}
          open={openId === channel.id}
          onToggle={() => setOpenId(openId === channel.id ? null : channel.id)}
          act={act}
          workspace={workspace}
        />
      ))}
    </div>
  );
}

function ChannelRow({
  channel,
  open,
  onToggle,
  act,
  workspace,
}: {
  channel: YtChannel;
  open: boolean;
  onToggle: () => void;
  act: ReturnType<typeof useApp>["act"];
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const [words, setWords] = useState(channel.words.join(", "));
  const [rank, setRank] = useState(channel.rank ?? "week");

  const muted = !channel.notifyEnabled;
  const status =
    channel.label === "blocked" ? "Blocked" : channel.active === false ? "Paused" : "Live";

  return (
    <>
      <div className="ch-row" data-open={open}>
        <div className="src">
          {channel.logo ? (
            <img
              className="src__logo"
              src={channel.logo}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="src__logo src__logo--fallback">
              {(channel.name ?? "?").slice(0, 2).toUpperCase()}
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <div className="src__name">{channel.name ?? "Unknown channel"}</div>
            <div className="src__url">{channel.rssId ?? channel.url}</div>
          </div>
        </div>

        <div className="cell-type">
          <select
            className="select"
            aria-label={`Notification type for ${channel.name}`}
            value={channel.kind ?? "tracking"}
            onChange={(event) => {
              const kind = event.target.value as YtKind;
              void act(() =>
                api.ytSetMode(
                  channel.id,
                  kind,
                  kind === "wordscan" ? channel.words : undefined,
                  kind === "random" ? rank : undefined,
                ),
              );
            }}
            style={{ height: 28, fontSize: 11.5 }}
          >
            {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
              <option
                key={kind}
                value={kind}
                disabled={kind === "playlist" && channel.kind !== "playlist"}
              >
                {TYPE_LABEL[kind]}
              </option>
            ))}
          </select>
        </div>

        <div className="cell-cat">
          <b>{channel.domain}</b>
          <i>/</i>
          {channel.subdomain}
        </div>

        <div>
          <Switch
            checked={channel.notify}
            label={`Notify for ${channel.name}`}
            onChange={(next) => void act(() => api.ytSetNotify(channel.id, next))}
          />
        </div>

        <div className="cell-state">
          <span
            className={`chip ${status === "Live" ? (muted ? "chip--warn" : "chip--ok") : status === "Paused" ? "chip--muted" : "chip--danger"}`}
          >
            {muted && status === "Live" ? (
              <>
                <BellOff size={9} /> muted
              </>
            ) : (
              status
            )}
          </span>
        </div>

        <div className="cell-actions">
          <button
            className="icon-btn"
            aria-label={open ? "Close editor" : "Edit source"}
            title="Edit"
            onClick={onToggle}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>

      {open && (
        <div className="row-editor">
          <div className="row-editor__grid">
            <label className="field">
              <span>Notification type</span>
              <select
                className="select"
                value={channel.kind ?? "tracking"}
                onChange={(event) => {
                  const kind = event.target.value as YtKind;
                  void act(
                    () =>
                      api.ytSetMode(
                        channel.id,
                        kind,
                        kind === "wordscan" ? channel.words : undefined,
                        kind === "random" ? rank : undefined,
                      ),
                    `Type set to ${TYPE_LABEL[kind]}`,
                  );
                }}
              >
                {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
                  <option
                    key={kind}
                    value={kind}
                    disabled={kind === "playlist" && channel.kind !== "playlist"}
                  >
                    {TYPE_LABEL[kind]}
                  </option>
                ))}
              </select>
            </label>

            {channel.kind === "wordscan" && (
              <label className="field">
                <span>WordScan terms</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    className="input"
                    value={words}
                    onChange={(event) => setWords(event.target.value)}
                    placeholder="comma, separated"
                  />
                  <button
                    className="btn btn--sm"
                    onClick={() =>
                      void act(
                        () =>
                          api.ytSetMode(
                            channel.id,
                            "wordscan",
                            words
                              .split(",")
                              .map((word) => word.trim())
                              .filter(Boolean),
                          ),
                        "WordScan terms saved",
                      )
                    }
                  >
                    Apply
                  </button>
                </div>
              </label>
            )}

            {channel.kind === "random" && (
              <label className="field">
                <span>Frequency</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    className="select"
                    value={rank}
                    onChange={(event) => setRank(event.target.value)}
                  >
                    {FREQUENCIES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn--sm"
                    onClick={() =>
                      void act(
                        () => api.ytSetMode(channel.id, "random", undefined, rank),
                        "Frequency saved",
                      )
                    }
                  >
                    Apply
                  </button>
                </div>
              </label>
            )}

            <label className="field">
              <span>Attach to domain</span>
              <select
                className="select"
                value={channel.subdomainId ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  void act(
                    () => api.ytAssignChannel(channel.id, value ? Number(value) : null),
                    "Category attached",
                  );
                }}
              >
                <option value="">Uncategorized</option>
                {workspace.ytDomains.map((domain) => (
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

            <label className="field">
              <span>Label</span>
              <select
                className="select"
                value={channel.label}
                onChange={(event) =>
                  void act(() =>
                    api.ytSetLabel(
                      channel.id,
                      event.target.value,
                      channel.labelReason ?? undefined,
                    ),
                  )
                }
              >
                <option value="none">None</option>
                <option value="reserved">Reserved (paused)</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>

            <div className="field">
              <span>Channel state</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, height: 34 }}>
                <Switch
                  checked={channel.active !== false}
                  label="Channel active"
                  onChange={(next) => void act(() => api.ytSetActive(channel.id, next))}
                />
                <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
                  {channel.active === false ? "Paused" : "Receiving"}
                </span>
              </div>
            </div>
          </div>

          <div className="row-editor__foot">
            <span className="chip chip--muted">
              <span className="dot" /> effective{" "}
              {channel.notifyEnabled ? (
                <BellRing size={9} style={{ color: "var(--ok)" }} />
              ) : (
                <BellOff size={9} />
              )}
              {channel.notifyEnabled ? "on" : "off"}
            </span>
            <span className="faint" style={{ fontSize: 11 }}>
              {channel.notifyEnabled
                ? "Delivered through the backend message lane."
                : "Any parent scope or this channel is muted."}
            </span>
            <span className="spacer" />
            {channel.url && (
              <a
                className="btn btn--sm btn--ghost"
                href={channel.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={12} /> Open
              </a>
            )}
            <ConfirmButton
              label={`Delete ${channel.name}`}
              className="btn btn--sm btn--danger"
              onConfirm={() => void act(() => api.ytDeleteChannel(channel.id), "Source deleted")}
            >
              <Trash2 size={12} /> Delete
            </ConfirmButton>
          </div>
        </div>
      )}
    </>
  );
}

export { TYPE_LABEL };
export function channelTypeIcon(_kind: YtKind) {
  return <ChevronDown size={12} />;
}
