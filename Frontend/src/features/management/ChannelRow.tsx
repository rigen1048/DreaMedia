import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useMedia, type ManagedChannel, type ManagedDomain } from "../media";
import { ChannelEditor } from "./ChannelEditor";
import { errorMessage, modeLabel, type ChannelLabel } from "./model";

type ChannelRowProps = {
  channel: ManagedChannel;
  onError: (message: string) => void;
};

export function ChannelRow({ channel, onError }: ChannelRowProps) {
  const { domains, setChannelLabel, setChannelActive, deleteChannel } = useMedia();
  const [label, setLabel] = useState<ChannelLabel>(channel.label);
  const [note, setNote] = useState(channel.note);
  const [domain, setDomain] = useState(channel.domain === "uncategorized" ? "" : channel.domain);
  const [subdomain, setSubdomain] = useState(
    channel.subdomain === "uncategorized" ? "" : channel.subdomain,
  );
  const [kind, setKind] = useState(channel.kind ?? "tracking");
  const [words, setWords] = useState(channel.words.join(", "));
  const [rank, setRank] = useState(channel.rank ?? "week");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    onError("");
    try {
      await operation();
      setOpen(false);
    } catch (error) {
      onError(errorMessage(error, "Backend update failed."));
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = (next: ChannelLabel) => {
    void run(async () => {
      await setChannelLabel(channel.id, next, note);
      setLabel(next);
    });
  };

  return (
    <article className="managed-source">
      <div className="managed-source-main">
        <div className="managed-source-identity">
          <span className="managed-source-glyph">{channel.name.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{channel.name}</strong>
            <small title={channel.url}>{channel.url}</small>
          </span>
        </div>
        <div className="managed-source-settings">
          <span className="managed-tag">{channel.kind ? modeLabel[channel.kind] : "Unknown"}</span>
          <span className="managed-category">
            {channel.domain} / {channel.subdomain}
          </span>
        </div>
        <div className="managed-source-actions">
          <button
            className={`active-toggle ${channel.active !== false ? "on" : ""}`}
            disabled={busy || channel.label === "blocked"}
            onClick={() => void run(() => setChannelActive(channel.id, channel.active === false))}
          >
            {channel.active === false ? "Inactive" : "Active"}
          </button>
          <select
            aria-label={`Label ${channel.name}`}
            value={label}
            onChange={(event) => saveLabel(event.target.value as ChannelLabel)}
          >
            <option value="none">None</option>
            <option value="reserved">Reserved</option>
            <option value="blocked">Blocked</option>
          </select>
          <button className="quiet-action" onClick={() => setOpen((value) => !value)}>
            Edit
          </button>
          <button
            className="icon-button small-icon"
            aria-label={`Delete ${channel.name}`}
            onClick={() => {
              if (window.confirm(`Delete ${channel.name} and its feed data?`)) {
                void run(() => deleteChannel(channel.id));
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {open && (
        <ChannelEditor
          channel={channel}
          domains={domains}
          label={label}
          note={note}
          domain={domain}
          subdomain={subdomain}
          kind={kind}
          words={words}
          rank={rank}
          busy={busy}
          setNote={setNote}
          setDomain={setDomain}
          setSubdomain={setSubdomain}
          setKind={setKind}
          setWords={setWords}
          setRank={setRank}
          run={run}
        />
      )}
    </article>
  );
}
