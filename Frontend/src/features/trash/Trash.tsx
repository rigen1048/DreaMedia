import { useQuery } from "@tanstack/react-query";
import { Trash2, Undo2 } from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import { EmptyState, Thumb } from "../../app/ui";
import { formatDate, timeAgo } from "../../lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** D57 trashbin: opened notifications live here for 24h, then purge. */
export default function Trash() {
  const { act } = useApp();
  const trash = useQuery({ queryKey: ["trash"], queryFn: api.fetchTrash });

  const yt = trash.data?.ytTrash ?? [];
  const ani = trash.data?.aniTrash ?? [];

  const restore = async (kind: "yt" | "ani", id: number) => {
    await act(
      () => (kind === "yt" ? api.ytRestoreVideos([id]) : api.aniRestoreEvents([id])),
      "Restored to the feed",
    );
    await trash.refetch();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Trashbin</h1>
          <p className="text-xs text-muted-foreground">
            Opened notifications land here and are deleted automatically after 24 hours.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          <b className="text-foreground">{yt.length + ani.length}</b> items pending purge
        </div>
      </div>

      {yt.length + ani.length === 0 ? (
        <EmptyState
          title="Trashbin is empty"
          hint="Open a notification and it moves here — restore it within 24 hours."
          icon={<Trash2 size={20} />}
        />
      ) : (
        <div className="space-y-2">
          {yt.map((item) => (
            <div key={`yt-${item.id}`} className="flex items-center gap-3 rounded-xl border bg-card p-3">
              <Thumb src={item.thumbnail} alt={item.title ?? "Video"} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{item.channel}</span>
                  <Badge variant="secondary" className="text-[10px]">YouTube</Badge>
                  <span>trashed {timeAgo(item.trashedAt)}</span>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void restore("yt", item.id)}>
                <Undo2 size={12} /> Restore
              </Button>
            </div>
          ))}
          {ani.map((item) => (
            <div key={`ani-${item.id}`} className="flex items-center gap-3 rounded-xl border bg-card p-3">
              <Thumb src={item.cover} alt={item.title ?? "Anime"} className="aspect-square w-16 object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{item.kind.replaceAll("_", " ")}</span>
                  <Badge variant="secondary" className="text-[10px]">Anime</Badge>
                  <span>trashed {timeAgo(item.trashedAt)}</span>
                  <span>· {formatDate(item.createdAt)}</span>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void restore("ani", item.id)}>
                <Undo2 size={12} /> Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
