import { useMemo, useState } from "react";
import { Ban, BellOff, BellRing, ChevronDown, ExternalLink, SlidersHorizontal, Trash2 } from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { ConfirmButton, EmptyState } from "../../app/ui";
import { Switch } from "@/components/ui/switch";
import type { YtChannel, YtKind } from "../../lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const TYPE_LABEL: Record<YtKind, string> = {
  tracking: "Track", wordscan: "WordScan", playlist: "Playlist", random: "Random",
  withhold: "Withhold",
};

const FREQUENCIES = [
  ["day", "Daily"], ["tri_day", "Every 3 days"], ["week", "Weekly"],
  ["bi_week", "Every 2 weeks"], ["month", "Monthly"],
] as const;

type Props = { search: string; filter: "all" | "muted" | "inactive"; onAdd: () => void };

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
          ? `${channel.name} ${channel.url} ${channel.domain} ${channel.subdomain} ${channel.kind}`.toLowerCase().includes(query)
          : true,
      );
  }, [filter, search, workspace.ytChannels]);

  if (!workspace.ytChannels.length) {
    return (
      <EmptyState
        title="No sources yet"
        hint="Add a YouTube channel or playlist link — the backend resolves it."
        action={<Button size="sm" onClick={onAdd}>Add source</Button>}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="grid grid-cols-[1fr_130px_150px_110px_50px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground max-lg:hidden">
        <span>Source</span><span>Type</span><span>Category</span><span>Status</span><span className="text-right">Open</span>
      </div>
      {rows.length === 0 && <EmptyState title="No sources match" hint="Try clearing the search or filter." />}
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
  channel, open, onToggle, act, workspace,
}: {
  channel: YtChannel;
  open: boolean;
  onToggle: () => void;
  act: ReturnType<typeof useApp>["act"];
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const [words, setWords] = useState(channel.words.join(", "));
  const [rank, setRank] = useState(channel.rank ?? "week");
  const [withhold, setWithhold] = useState(channel.withholdThreshold ?? 2);

  const muted = !channel.notifyEnabled;
  const status = channel.label === "blocked" ? "Blocked" : channel.active === false ? "Paused" : "Live";
  // Withhold is a tracking row with a threshold — display it as its own type.
  const displayKind: YtKind = channel.withholdThreshold ? "withhold" : (channel.kind ?? "tracking");

  const typeSelect = (kind: YtKind) =>
    act(() =>
      api.ytSetMode(
        channel.id,
        kind,
        kind === "wordscan" ? channel.words : undefined,
        kind === "random" ? rank : undefined,
        kind === "withhold" ? withhold : undefined,
      ),
    );

  return (
    <>
      <div className={cn(
        "grid grid-cols-[1fr_130px_150px_110px_50px] items-center gap-2 border-b px-3 py-2.5 max-lg:grid-cols-[1fr_50px]",
        open && "bg-accent/40",
      )}>
        <div className={cn("flex min-w-0 items-center gap-2.5 cursor-pointer", open && "bg-accent/20 rounded-md p-1")} onClick={onToggle} role="button" tabIndex={0} aria-label={`Edit ${channel.name}`}>
          {channel.logo ? (
            <img className="h-8 w-8 shrink-0 rounded-full object-cover" src={channel.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold">
              {(channel.name ?? "?").slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{channel.name ?? "Unknown channel"}</div>
            <div className="truncate text-xs text-muted-foreground">{channel.rssId ?? channel.url}</div>
          </div>
        </div>

        <div className="max-lg:hidden">
          <Select value={displayKind} onValueChange={(value) => void typeSelect(value as YtKind)}>
            <SelectTrigger className="h-8" aria-label={`Notification type for ${channel.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
                <SelectItem key={kind} value={kind} disabled={kind === "playlist" && channel.kind !== "playlist"}>
                  {TYPE_LABEL[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="truncate text-xs max-lg:hidden">
          <b>{channel.domain}</b>
          <i className="not-italic opacity-50"> / </i>
          {channel.subdomain}
        </div>

        <div className="max-lg:hidden">
          {muted && status === "Live" ? (
            <Badge variant="outline" className="gap-1 text-[10px]"><BellOff size={9} /> muted</Badge>
          ) : (
            <Badge
              variant={status === "Live" ? "secondary" : status === "Paused" ? "outline" : "destructive"}
              className="text-[10px]"
            >
              {status}
            </Badge>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={open ? "Close editor" : "Edit source"} title="Edit" onClick={onToggle}>
            <SlidersHorizontal size={14} />
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-b bg-muted/30 px-4 py-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Notification type</Label>
              <Select value={displayKind} onValueChange={(value) => void typeSelect(value as YtKind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
                    <SelectItem key={kind} value={kind} disabled={kind === "playlist" && channel.kind !== "playlist"}>
                      {TYPE_LABEL[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {displayKind === "withhold" && (
              <div className="space-y-1.5">
                <Label>Withhold threshold</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={withhold}
                    aria-label="Withhold threshold"
                    onChange={(event) => {
                      const v = Number(event.target.value);
                      if (Number.isFinite(v)) setWithhold(Math.max(1, Math.round(v)));
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      void act(
                        () => api.ytSetMode(channel.id, "withhold", undefined, undefined, withhold),
                        "Withhold threshold saved",
                      )
                    }
                  >
                    Apply
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  New videos buffer invisibly until this many accumulate, then all show at once.
                </p>
              </div>
            )}

            {channel.kind === "wordscan" && (
              <div className="space-y-1.5">
                <Label>WordScan terms</Label>
                <div className="flex gap-2">
                  <Input value={words} onChange={(event) => setWords(event.target.value)} placeholder="comma, separated" />
                  <Button
                    size="sm"
                    onClick={() =>
                      void act(
                        () => api.ytSetMode(channel.id, "wordscan", words.split(",").map((word) => word.trim()).filter(Boolean)),
                        "WordScan terms saved",
                      )
                    }
                  >
                    Apply
                  </Button>
                </div>
              </div>
            )}

            {channel.kind === "random" && (
              <div className="space-y-1.5">
                <Label>Frequency</Label>
                <div className="flex gap-2">
                  <Select value={rank} onValueChange={setRank}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FREQUENCIES.map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={() => void act(() => api.ytSetMode(channel.id, "random", undefined, rank), "Frequency saved")}>
                    Apply
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Attach to domain</Label>
              <Select
                value={channel.subdomainId ? String(channel.subdomainId) : "none"}
                onValueChange={(value) =>
                  void act(() => api.ytAssignChannel(channel.id, value === "none" ? null : Number(value)), "Category attached")
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorized</SelectItem>
                  {workspace.ytDomains.flatMap((domain) =>
                    domain.subdomains.map((subdomain) => (
                      <SelectItem key={subdomain.id} value={String(subdomain.id)}>
                        {domain.name} / {subdomain.name}
                      </SelectItem>
                    )),
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Channel state</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  checked={channel.active !== false}
                  aria-label="Channel active"
                  onCheckedChange={(next) => void act(() => api.ytSetActive(channel.id, next))}
                />
                <span className="text-xs text-muted-foreground">{channel.active === false ? "Paused — still subscribed, receiving nothing" : "Receiving"}</span>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
            <Badge variant="outline" className="gap-1 text-[10px]">
              {channel.notifyEnabled ? <BellRing size={9} className="text-emerald-500" /> : <BellOff size={9} />}
              effective {channel.notifyEnabled ? "on" : "off"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {channel.notifyEnabled ? "Delivered through the backend message lane." : "Any parent scope or this channel is muted."}
            </span>
            <span className="grow" />
            {channel.url && (
              <Button variant="ghost" size="sm" asChild>
                <a href={channel.url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Open</a>
              </Button>
            )}
            {channel.label !== "blocked" && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void act(() => api.ytSetLabel(channel.id, "blocked", "Blocked from management"), "Source blocked")}
              >
                <Ban size={12} /> Block
              </Button>
            )}
            <ConfirmButton
              label={`Delete ${channel.name}`}
              className="h-8 w-8"
              onConfirm={() => void act(() => api.ytDeleteChannel(channel.id), "Source deleted")}
            >
              <Trash2 size={12} />
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
