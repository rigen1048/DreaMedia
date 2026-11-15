import { useEffect, useRef, useState } from "react";
import { Check, ListVideo, Trash2, X } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { ConfirmButton } from "../../app/ui";
import { formatDate } from "../../lib/format";

/**
 * The full playlist lives in a right-hand drawer instead of inside the card:
 * the grid stays a grid of small tiles, and the video list gets room to
 * breathe (thumbnail + title, each row the link to the video).
 */
export function PlaylistDrawer({ cardId, onClose }: { cardId: number; onClose: () => void }) {
  const workspace = useWorkspace();
  const { refresh } = useApp();
  const card = workspace.ytCards.find((item) => item.id === cardId);
  const [name, setName] = useState(card?.name ?? "");
  const [links, setLinks] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setName(card?.name ?? ""), [card?.name]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!card) return null;

  const percent = card.total ? Math.round((card.done / card.total) * 100) : 0;

  const saveName = async () => {
    const next = name.trim();
    if (!next || next === card.name) return;
    await api.ytRenameCard(card.id, next);
    await refresh();
  };

  const addLinks = async () => {
    const parsed = links
      .split(/[\s,]+/)
      .map((link) => link.trim())
      .filter((link) => link.length > 4);
    if (!parsed.length) return;
    setLinks("");
    await api.ytAddCardItems(card.id, parsed);
    await refresh();
  };

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Playlist ${card.name ?? "untitled"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer__head">
          <ListVideo size={15} style={{ color: "var(--accent)" }} />
          <input
            ref={nameRef}
            className="drawer__title"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            aria-label="Playlist name"
          />
          <span className="count">
            {card.done}/{card.total}
          </span>
          <ConfirmButton
            label={`Delete playlist ${card.name}`}
            onConfirm={async () => {
              await api.ytDeleteCard(card.id);
              await refresh();
              onClose();
            }}
          >
            <Trash2 size={13} />
          </ConfirmButton>
          <button className="icon-btn" onClick={onClose} aria-label="Close playlist">
            <X size={15} />
          </button>
        </header>

        <div className="drawer__meta">
          <div className="progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <span>{percent}%</span>
          <span className="faint">created {formatDate(card.createdAt)}</span>
        </div>

        <div className="drawer__body">
          {card.items.length === 0 ? (
            <p className="drawer__empty">
              No videos yet. Paste YouTube links below — the backend resolves titles and
              thumbnails in the background.
            </p>
          ) : (
            card.items.map((item) => (
              <div className="pl-item" key={item.id} data-done={item.done}>
                <button
                  className="check"
                  data-checked={item.done}
                  aria-label={item.done ? "Mark not done" : "Mark done"}
                  onClick={async () => {
                    await api.ytSetCardItemDone(item.id, !item.done);
                    await refresh();
                  }}
                >
                  {item.done && <Check size={9} />}
                </button>
                <a
                  className="pl-item__link"
                  href={item.url ?? `https://www.youtube.com/watch?v=${item.videoId}`}
                  target="_blank"
                  rel="noreferrer"
                  title={item.title ?? item.url ?? ""}
                  aria-label={`Open ${item.title ?? item.url ?? "video"}`}
                >
                  {item.thumbnail ? (
                    <img
                      src={item.thumbnail}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="thumb-fallback" />
                  )}
                  <span className="pl-item__title">
                    {item.title ?? item.url ?? item.videoId}
                  </span>
                </a>
                <ConfirmButton
                  label="Remove item"
                  className="icon-btn icon-btn--danger"
                  onConfirm={async () => {
                    await api.ytDeleteCardItem(item.id);
                    await refresh();
                  }}
                >
                  <Trash2 size={11} />
                </ConfirmButton>
              </div>
            ))
          )}
        </div>

        <footer className="drawer__foot">
          <input
            className="input"
            value={links}
            onChange={(event) => setLinks(event.target.value)}
            placeholder="Paste links — one per line or comma separated"
            onKeyDown={(event) => event.key === "Enter" && void addLinks()}
          />
          <button className="btn btn--sm btn--primary" disabled={!links.trim()} onClick={() => void addLinks()}>
            Add
          </button>
        </footer>
      </aside>
    </div>
  );
}
