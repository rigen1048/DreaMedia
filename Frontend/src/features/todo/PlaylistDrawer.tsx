import { useEffect, useRef, useState } from "react";
import { Check, ListVideo, Trash2, X } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { ConfirmButton } from "../../app/ui";
import { formatDate } from "../../lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    <div className="fixed inset-0 z-50 bg-black/70" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Playlist ${card.name ?? "untitled"}`}
        onClick={(event) => event.stopPropagation()}
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l bg-card shadow-xl"
      >
        <header className="flex items-center gap-2 border-b p-4">
          <ListVideo size={15} className="shrink-0 text-sky-500" />
          <Input
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            aria-label="Playlist name"
            className="h-8 border-transparent bg-transparent px-1 text-sm font-semibold focus-visible:border-input"
          />
          <span className="text-xs text-muted-foreground">{card.done}/{card.total}</span>
          <ConfirmButton
            label={`Delete playlist ${card.name}`}
            className="h-8 w-8"
            onConfirm={async () => {
              await api.ytDeleteCard(card.id);
              await refresh();
              onClose();
            }}
          >
            <Trash2 size={13} />
          </ConfirmButton>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close playlist">
            <X size={15} />
          </Button>
        </header>

        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-xs">{percent}%</span>
          <span className="text-xs text-muted-foreground">created {formatDate(card.createdAt)}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {card.items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No videos yet. Paste YouTube links below — the backend resolves titles and
              thumbnails in the background.
            </p>
          ) : (
            <div className="space-y-1">
              {card.items.map((item) => (
                <div
                  key={item.id}
                  className={cn("flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-accent/50", item.done && "opacity-55")}
                >
                  <button
                    aria-label={item.done ? "Mark not done" : "Mark done"}
                    onClick={async () => {
                      await api.ytSetCardItemDone(item.id, !item.done);
                      await refresh();
                    }}
                    className={cn(
                      "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border transition-colors cursor-pointer",
                      item.done ? "border-sky-500 bg-sky-500 text-white" : "border-muted-foreground/40 hover:border-foreground",
                    )}
                    style={{ width: 18, height: 18 }}
                  >
                    {item.done && <Check size={10} strokeWidth={3} />}
                  </button>
                  <a
                    href={item.url ?? `https://www.youtube.com/watch?v=${item.videoId}`}
                    target="_blank"
                    rel="noreferrer"
                    title={item.title ?? item.url ?? ""}
                    aria-label={`Open ${item.title ?? item.url ?? "video"}`}
                    className="flex min-w-0 flex-1 items-center gap-2.5"
                  >
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="aspect-video w-24 rounded object-cover" />
                    ) : (
                      <span className="aspect-video w-24 rounded bg-muted" />
                    )}
                    <span className={cn("truncate text-sm", item.done && "line-through")}>
                      {item.title ?? item.url ?? item.videoId}
                    </span>
                  </a>
                  <ConfirmButton
                    label="Remove item"
                    className="h-7 w-7"
                    onConfirm={async () => {
                      await api.ytDeleteCardItem(item.id);
                      await refresh();
                    }}
                  >
                    <Trash2 size={11} />
                  </ConfirmButton>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="flex gap-2 border-t p-4">
          <Input
            value={links}
            onChange={(event) => setLinks(event.target.value)}
            placeholder="Paste links — one per line or comma separated"
            onKeyDown={(event) => event.key === "Enter" && void addLinks()}
          />
          <Button size="sm" disabled={!links.trim()} onClick={() => void addLinks()}>
            Add
          </Button>
        </footer>
      </aside>
    </div>
  );
}
