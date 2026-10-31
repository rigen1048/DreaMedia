import type { Dispatch, SetStateAction } from "react";
import { useMedia, type ManagedChannel, type ManagedDomain } from "../media";
import type { YtKind } from "../media/api";
import { frequencies, type ChannelLabel } from "./model";

type ChannelEditorProps = {
  channel: ManagedChannel;
  domains: ManagedDomain[];
  label: ChannelLabel;
  note: string;
  domain: string;
  subdomain: string;
  kind: YtKind;
  words: string;
  rank: string;
  busy: boolean;
  setNote: Dispatch<SetStateAction<string>>;
  setDomain: Dispatch<SetStateAction<string>>;
  setSubdomain: Dispatch<SetStateAction<string>>;
  setKind: Dispatch<SetStateAction<YtKind>>;
  setWords: Dispatch<SetStateAction<string>>;
  setRank: Dispatch<SetStateAction<string>>;
  run: (operation: () => Promise<void>) => Promise<void>;
};

export function ChannelEditor({
  channel,
  domains,
  label,
  note,
  domain,
  subdomain,
  kind,
  words,
  rank,
  busy,
  setNote,
  setDomain,
  setSubdomain,
  setKind,
  setWords,
  setRank,
  run,
}: ChannelEditorProps) {
  const { setChannelLabel, switchChannelMode, assignChannel } = useMedia();
  const matchingDomain = domains.find((item) => item.name === domain);

  const saveMode = () =>
    run(async () => {
      if (kind === "playlist") {
        throw new Error(
          "Switching to a Playlist requires adding it with its playlist link, so the backend can resolve it.",
        );
      }
      const nextWords = words
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean);
      if (kind === "wordscan" && nextWords.length === 0) {
        throw new Error("Enter at least one Wordscan term.");
      }
      await switchChannelMode(channel.id, kind, nextWords, rank);
    });

  const saveCategory = () =>
    run(async () => {
      if (!domain.trim() || !subdomain.trim()) {
        throw new Error(
          "Choose both a domain and subdomain. The current backend assigns sources at subdomain level.",
        );
      }
      await assignChannel(channel.id, domain.trim(), subdomain.trim());
    });

  const saveLabel = () => run(() => setChannelLabel(channel.id, label, note));

  return (
    <div className="source-editor">
      <div className="editor-grid">
        <label>
          Notification type
          <select value={kind} onChange={(event) => setKind(event.target.value as YtKind)}>
            <option value="tracking">Track</option>
            <option value="wordscan">Wordscan</option>
            <option value="random">Random</option>
            <option value="playlist">Playlist (add link)</option>
          </select>
        </label>
        {kind === "wordscan" && (
          <label>
            Words
            <input
              value={words}
              onChange={(event) => setWords(event.target.value)}
              placeholder="one word, comma-separated"
            />
          </label>
        )}
        {kind === "random" && (
          <label>
            Frequency
            <select value={rank} onChange={(event) => setRank(event.target.value)}>
              {frequencies.map(([value, caption]) => (
                <option key={value} value={value}>
                  {caption}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Domain
          <input
            list={`domains-${channel.id}`}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
          <datalist id={`domains-${channel.id}`}>
            {domains.map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>
        </label>
        <label>
          Subdomain
          <input
            list={`subdomains-${channel.id}`}
            value={subdomain}
            onChange={(event) => setSubdomain(event.target.value)}
          />
          <datalist id={`subdomains-${channel.id}`}>
            {matchingDomain?.subdomains.map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>
        </label>
      </div>
      {label !== "none" && (
        <label className="wide-label">
          Label note
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional note"
          />
        </label>
      )}
      <div className="form-actions">
        <button
          className="primary-button small-primary"
          disabled={busy || kind === "playlist"}
          onClick={saveMode}
        >
          {busy ? "Saving…" : "Save type"}
        </button>
        <button
          className="quiet-action"
          disabled={busy || !domain.trim() || !subdomain.trim()}
          onClick={saveCategory}
        >
          Assign category
        </button>
        <button className="quiet-action" disabled={busy} onClick={saveLabel}>
          Save label
        </button>
      </div>
    </div>
  );
}
