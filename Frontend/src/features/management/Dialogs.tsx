import { useState } from "react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

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
          words: kind === "wordscan" ? words.split(",").map((word) => word.trim()).filter(Boolean) : undefined,
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add YouTube source</DialogTitle>
          <DialogDescription>Channel, playlist or video link. The backend resolves the channel id and keeps polling it.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Link</Label>
            <Input
              autoFocus
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://www.youtube.com/@channel or a playlist/video URL"
              onKeyDown={(event) => event.key === "Enter" && void submit()}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Notification type</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tracking">Track — every upload</SelectItem>
                  <SelectItem value="wordscan">WordScan — only matching titles</SelectItem>
                  <SelectItem value="random">Random — occasional picks</SelectItem>
                  <SelectItem value="playlist">Playlist — new playlist items</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kind === "random" && (
              <div className="space-y-1.5">
                <Label>Frequency</Label>
                <Select value={rank} onValueChange={setRank}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Daily</SelectItem>
                    <SelectItem value="tri_day">Every 3 days</SelectItem>
                    <SelectItem value="week">Weekly</SelectItem>
                    <SelectItem value="bi_week">Every 2 weeks</SelectItem>
                    <SelectItem value="month">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {kind === "wordscan" && (
            <div className="space-y-1.5">
              <Label>Words to match (comma separated)</Label>
              <Input value={words} onChange={(event) => setWords(event.target.value)} placeholder="trailer, live, devlog" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Domain (optional)</Label>
              <Input list="yt-domains" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="Technology" />
              <datalist id="yt-domains">
                {workspace.ytDomains.map((item) => (
                  <option key={item.id} value={item.name} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label>Subdomain (optional)</Label>
              <Input list="yt-subs" value={subdomain} onChange={(event) => setSubdomain(event.target.value)} placeholder="AI" />
              <datalist id="yt-subs">
                {[...new Set(workspace.ytDomains.flatMap((item) => item.subdomains.map((sub) => sub.name)))].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          </div>
        </div>

        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground">Missing categories are created automatically.</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!link.trim() || busy} onClick={() => void submit()}>
            {busy ? "Resolving…" : "Add source"}
          </Button>
        </DialogFooter>
      </DialogContent>
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
      const created = await api.aniTrack(title.trim(), list, domain.trim() || undefined, subdomain.trim() || undefined);
      let message = "Anime tracked — seasons and episode counts resolved";
      if (list === "watching") {
        await api.aniSetCursor(created.aniTrack, Math.max(1, watchTillSeason), Math.max(0, watchTillEpisode), Math.max(0, watchTillTime));
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Track anime</DialogTitle>
          <DialogDescription>Metadata (type, seasons, episodes, release) comes from AniList via the backend.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Frieren: Beyond Journey's End"
              onKeyDown={(event) => event.key === "Enter" && void submit()}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Track as</Label>
            <div className="flex gap-1.5">
              {([["watching", "Watching"], ["up_to_date", "UpToDate"], ["watchlist", "Watchlist"]] as const).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  onClick={() => setList(value)}
                  className={cn(
                    "h-auto rounded-full border px-3 py-1 text-xs font-medium",
                    list === value ? "bg-primary text-primary-foreground border-transparent hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground",
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {list === "watching" && (
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Watch till · Season</Label>
                <Input type="number" min={1} value={watchTillSeason} onChange={(event) => setWatchTillSeason(Number(event.target.value))} />
              </div>
              <div className="space-y-1.5">
                <Label>Episode</Label>
                <Input type="number" min={0} value={watchTillEpisode} onChange={(event) => setWatchTillEpisode(Number(event.target.value))} />
              </div>
              <div className="space-y-1.5">
                <Label>Time (seconds)</Label>
                <Input type="number" min={0} value={watchTillTime} onChange={(event) => setWatchTillTime(Number(event.target.value))} />
              </div>
            </div>
          )}

          {list === "watchlist" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Watchlist status</Label>
                <Select value={watchlistState} onValueChange={(value) => setWatchlistState(value as typeof watchlistState)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="not_yet">Not yet</SelectItem>
                    <SelectItem value="confirmed">Confirmed</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="blocked">Blocked</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {watchlistState === "completed" && (
                <div className="space-y-1.5">
                  <Label>Completed through season (optional)</Label>
                  <Input type="number" min={1} value={completedSeason} onChange={(event) => setCompletedSeason(Number(event.target.value))} />
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Domain (optional)</Label>
              <Input list="ani-domains" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="Seasonal" />
              <datalist id="ani-domains">
                {workspace.aniDomains.map((item) => (
                  <option key={item.id} value={item.name} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label>Subdomain (optional)</Label>
              <Input value={subdomain} onChange={(event) => setSubdomain(event.target.value)} placeholder="Winter 2026" />
            </div>
          </div>
        </div>

        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground">Needs outbound access to AniList.</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? "Resolving…" : "Track"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
