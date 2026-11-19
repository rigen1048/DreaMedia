import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";

export function Dialog({
  title,
  hint,
  onClose,
  children,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal__head">
          <div>
            <h3>{title}</h3>
            {hint && <p>{hint}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AddSourceDialog({ onClose }: { onClose: () => void }) {
  const { act } = useApp();
  const workspace = useWorkspace();
  const [link, setLink] = useState("");
  const [kind, setKind] = useState("tracking");
  const [words, setWords] = useState("");
  const [rank, setRank] = useState("week");
  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!link.trim() || busy) return;
    setBusy(true);
    const ok = await act(
      () =>
        api.subscribeYoutube({
          kind,
          link: link.trim(),
          words:
            kind === "wordscan"
              ? words
                  .split(",")
                  .map((word) => word.trim())
                  .filter(Boolean)
              : undefined,
          rank: kind === "random" ? rank : undefined,
          domain: domain.trim() || undefined,
          subdomain: subdomain.trim() || undefined,
        }),
      "Source added — backend resolved the feed",
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      title="Add YouTube source"
      hint="Channel, playlist or video link. The backend resolves the channel id and keeps polling it."
      onClose={onClose}
    >
      <div className="modal__body">
        <label className="field">
          <span>Link</span>
          <input
            className="input"
            autoFocus
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://www.youtube.com/@channel or a playlist/video URL"
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </label>

        <div className="modal__row">
          <label className="field">
            <span>Notification type</span>
            <select
              className="select"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="tracking">Track — every upload</option>
              <option value="wordscan">WordScan — only matching titles</option>
              <option value="random">Random — occasional picks</option>
              <option value="playlist">Playlist — new playlist items</option>
            </select>
          </label>
          {kind === "random" && (
            <label className="field">
              <span>Frequency</span>
              <select
                className="select"
                value={rank}
                onChange={(event) => setRank(event.target.value)}
              >
                <option value="day">Daily</option>
                <option value="tri_day">Every 3 days</option>
                <option value="week">Weekly</option>
                <option value="bi_week">Every 2 weeks</option>
                <option value="month">Monthly</option>
              </select>
            </label>
          )}
        </div>

        {kind === "wordscan" && (
          <label className="field">
            <span>Words to match (comma separated)</span>
            <input
              className="input"
              value={words}
              onChange={(event) => setWords(event.target.value)}
              placeholder="trailer, live, devlog"
            />
          </label>
        )}

        <div className="modal__row">
          <label className="field">
            <span>Domain (optional)</span>
            <input
              className="input"
              list="yt-domains"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="Technology"
            />
            <datalist id="yt-domains">
              {workspace.ytDomains.map((item) => (
                <option key={item.id} value={item.name} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Subdomain (optional)</span>
            <input
              className="input"
              list="yt-subs"
              value={subdomain}
              onChange={(event) => setSubdomain(event.target.value)}
              placeholder="AI"
            />
            <datalist id="yt-subs">
              {[
                ...new Set(
                  workspace.ytDomains.flatMap((item) => item.subdomains.map((sub) => sub.name)),
                ),
              ].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
        </div>
      </div>

      <div className="modal__foot">
        <span className="faint" style={{ fontSize: 11 }}>
          Missing categories are created automatically.
        </span>
        <span className="grow" />
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          disabled={!link.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "Resolving…" : "Add source"}
        </button>
      </div>
    </Dialog>
  );
}

export function AddAnimeDialog({ onClose }: { onClose: () => void }) {
  const { notify, refresh } = useApp();
  const workspace = useWorkspace();
  const [title, setTitle] = useState("");
  const [list, setList] = useState<"watching" | "up_to_date" | "watchlist">("watching");
  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [watchlistState, setWatchlistState] = useState<"not_yet" | "confirmed" | "completed" | "blocked">("not_yet");
  const [watchTillSeason, setWatchTillSeason] = useState(1);
  const [watchTillEpisode, setWatchTillEpisode] = useState(0);
  const [watchTillTime, setWatchTillTime] = useState(0);
  const [completedSeason, setCompletedSeason] = useState(1);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.aniTrack(
        title.trim(),
        list,
        domain.trim() || undefined,
        subdomain.trim() || undefined,
      );
      let message = "Anime tracked — seasons and episode counts resolved";
      if (list === "watching") {
        await api.aniSetCursor(
          created.aniTrack,
          Math.max(1, watchTillSeason),
          Math.max(0, watchTillEpisode),
          Math.max(0, watchTillTime),
        );
        message = `Watching — till S${Math.max(1, watchTillSeason)} E${Math.max(0, watchTillEpisode)}`;
      } else if (list === "up_to_date") {
        message = "UpToDate — release notifications enabled";
      } else if (watchlistState === "completed") {
        await api.aniUpdateEntry(created.aniTrack, { label: "completed" });
        await api.aniSetProgress(created.aniTrack, Math.max(1, completedSeason), 0);
        message = `Watchlist — completed through Season ${Math.max(1, completedSeason)}`;
      } else if (watchlistState === "blocked") {
        await api.aniUpdateEntry(created.aniTrack, { label: "blocked" });
        message = "Watchlist — blocked";
      } else if (watchlistState === "confirmed") {
        await api.aniUpdateEntry(created.aniTrack, { watchState: "confirmed" });
        message = "Watchlist — confirmed";
      }
      await refresh();
      notify(message, "ok");
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not track that anime", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Track anime"
      hint="Metadata (type, seasons, episodes, release) comes from AniList via the backend."
      onClose={onClose}
    >
      <div className="modal__body">
        <label className="field">
          <span>Title</span>
          <input
            className="input"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Frieren: Beyond Journey's End"
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </label>

        <div className="field">
          <span>Track as</span>
          <div className="filterbar">
            {[
              ["watching", "Watching"],
              ["up_to_date", "UpToDate"],
              ["watchlist", "Watchlist"],
            ].map(([value, label]) => (
              <button
                key={value}
                className="chipbtn"
                data-active={list === value}
                onClick={() => setList(value as typeof list)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {list === "watching" && (
          <div className="modal__row">
            <label className="field">
              <span>Watch till · Season</span>
              <input
                className="input"
                type="number"
                min={1}
                value={watchTillSeason}
                onChange={(event) => setWatchTillSeason(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Episode</span>
              <input
                className="input"
                type="number"
                min={0}
                value={watchTillEpisode}
                onChange={(event) => setWatchTillEpisode(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Time (seconds)</span>
              <input className="input" type="number" min={0} value={watchTillTime} onChange={(event) => setWatchTillTime(Number(event.target.value))} />
            </label>
          </div>
        )}

        {list === "watchlist" && (
          <div className="modal__row">
            <label className="field">
              <span>Watchlist status</span>
              <select className="select" value={watchlistState} onChange={(event) => setWatchlistState(event.target.value as typeof watchlistState)}>
                <option value="not_yet">Not yet</option>
                <option value="confirmed">Confirmed</option>
                <option value="completed">Completed</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            {watchlistState === "completed" && <label className="field"><span>Completed through season (optional)</span><input className="input" type="number" min={1} value={completedSeason} onChange={(event) => setCompletedSeason(Number(event.target.value))} /></label>}
          </div>
        )}


        <div className="modal__row">
          <label className="field">
            <span>Domain (optional)</span>
            <input
              className="input"
              list="ani-domains"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="Seasonal"
            />
            <datalist id="ani-domains">
              {workspace.aniDomains.map((item) => (
                <option key={item.id} value={item.name} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Subdomain (optional)</span>
            <input
              className="input"
              value={subdomain}
              onChange={(event) => setSubdomain(event.target.value)}
              placeholder="Winter 2026"
            />
          </label>
        </div>
      </div>

      <div className="modal__foot">
        <span className="faint" style={{ fontSize: 11 }}>
          Needs outbound access to AniList.
        </span>
        <span className="grow" />
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          disabled={!title.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "Resolving…" : "Track"}
        </button>
      </div>
    </Dialog>
  );
}
