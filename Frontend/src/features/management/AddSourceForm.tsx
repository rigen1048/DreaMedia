import { useState, type FormEvent } from "react";
import type { ManagedDomain } from "../media";
import type { SubscribeInput, YtKind } from "../media/api";
import { createSubscribeInput, errorMessage, frequencies, type CategoryAssignment } from "./model";

type AddSourceFormProps = {
  domains: ManagedDomain[];
  onAdd: (input: SubscribeInput, category?: CategoryAssignment) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
};

export function AddSourceForm({ domains, onAdd, onCancel, onError }: AddSourceFormProps) {
  const [link, setLink] = useState("");
  const [kind, setKind] = useState<YtKind>("tracking");
  const [words, setWords] = useState("");
  const [rank, setRank] = useState("week");
  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    onError("");

    try {
      const input = createSubscribeInput(kind, link, words, rank);
      const trimmedDomain = domain.trim();
      const trimmedSubdomain = subdomain.trim();
      if (trimmedDomain && !trimmedSubdomain) {
        throw new Error(
          "Add a subdomain when assigning a new source. The backend assigns sources at subdomain level.",
        );
      }

      const category = trimmedDomain
        ? { domain: trimmedDomain, subdomain: trimmedSubdomain }
        : undefined;
      await onAdd(input, category);
      setLink("");
      setWords("");
      onCancel();
    } catch (error) {
      onError(errorMessage(error, "Backend update failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-source-form" onSubmit={submit}>
      <div className="form-heading">
        <strong>Add YouTube source</strong>
        <span>
          Paste a channel handle/URL, a channel ID, or a playlist link. Resolution stays in the
          backend.
        </span>
      </div>
      <label>
        Channel or playlist link
        <input
          autoFocus
          required
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://www.youtube.com/@THECHAINSMOKERS/videos"
        />
      </label>
      <label>
        Mode
        <select value={kind} onChange={(event) => setKind(event.target.value as YtKind)}>
          <option value="tracking">Track</option>
          <option value="wordscan">Wordscan</option>
          <option value="playlist">Playlist</option>
          <option value="random">Random</option>
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
        Domain (optional)
        <input
          list="all-domains"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
        />
        <datalist id="all-domains">
          {domains.map((item) => (
            <option key={item.id} value={item.name} />
          ))}
        </datalist>
      </label>
      <label>
        Subdomain (optional)
        <input value={subdomain} onChange={(event) => setSubdomain(event.target.value)} />
      </label>
      <div className="form-actions">
        <button className="primary-button" disabled={busy}>
          {busy ? "Sending…" : "Add through backend"}
        </button>
        <button className="quiet-action" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
