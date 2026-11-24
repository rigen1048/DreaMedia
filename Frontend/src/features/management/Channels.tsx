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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const TYPE_LABEL: Record<YtKind, string> = {
  tracking: "Track",
  wordscan: "WordScan",
  playlist: "Playlist",
  random: "Random",
  withhold: "Withhold",
};

const FREQUENCIES = [
  ["day", "Daily"],
  ["tri_day", "Every 3 days"],
  ["week", "Weekly"],
  ["bi_week", "Every 2 weeks"],
  ["month", "Monthly"],
] as const;

type Props = { search: string; filter: "all" | "muted"; onAdd: () => void };

type BatchAction =
  | "mode"
  | "category"
  | "alerts"
  | "active"
  | "label"
  | "delete";

export default function Channels({ search, filter, onAdd }: Props) {
  const { act } = useApp();
  const workspace = useWorkspace();
  const [openId, setOpenId] = useState<number | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());
  const [batchAction, setBatchAction] = useState<BatchAction | null>(null);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);

  // Batch action config state
  const [batchKind, setBatchKind] = useState<YtKind>("tracking");
  const [batchRank, setBatchRank] = useState<string>("week");
  const [batchWithhold, setBatchWithhold] = useState<number>(2);
  const [batchSubdomainId, setBatchSubdomainId] = useState<number | null>(null);
  const [batchAlerts, setBatchAlerts] = useState<boolean>(true);
  const [batchActive, setBatchActive] = useState<boolean>(true);
  const [batchLabel, setBatchLabel] = useState<string>("none");
  const [batchLabelReason, setBatchLabelReason] = useState<string>("");

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workspace.ytChannels
      .filter((channel) => channel.label !== "blocked")
      .filter((channel) => {
        if (filter === "muted") return !channel.alertsEnabled;
        return true;
      })
      .filter((channel) =>
        query
          ? `${channel.name} ${channel.url} ${channel.domain} ${channel.subdomain} ${channel.kind}`.toLowerCase().includes(query)
          : true,
      );
  }, [filter, search, workspace.ytChannels]);

  const allSelected =
    rows.length > 0 && rows.every((row) => selectedChannels.has(row.id));

  const toggleChannel = (id: number) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedChannels(new Set());
    } else {
      setSelectedChannels(new Set(rows.map((row) => row.id)));
    }
  };

  const hasSelection = selectedChannels.size > 0;

  const applyBatch = async () => {
    const ids = Array.from(selectedChannels);

    switch (batchAction) {
      case "mode":
        await act(
          () =>
            api.ytBatchSetMode(ids, batchKind,
              batchKind === "wordscan" ? undefined : [],
              batchKind === "random" ? batchRank : undefined,
              batchKind === "withhold" ? batchWithhold : undefined,
            ),
          `${ids.length} sources switched to ${TYPE_LABEL[batchKind]}`,
        );
        break;
      case "category":
        await act(
          () => api.ytBatchAssignChannel(ids, batchSubdomainId),
          `${ids.length} sources recategorised`,
        );
        break;
      case "alerts":
        await act(() => api.ytBatchSetAlerts(ids, batchAlerts), `${ids.length} sources updated`);
        break;
      case "active":
        await act(() => api.ytBatchSetActive(ids, batchActive), `${ids.length} sources updated`);
        break;
      case "label":
        await act(
          () => api.ytBatchSetLabel(ids, batchLabel, batchLabelReason || undefined),
          `${ids.length} sources labelled`,
        );
        break;
      case "delete":
        await act(() => api.ytBatchDeleteChannel(ids), `${ids.length} sources deleted`);
        break;
    }

    setSelectedChannels(new Set());
    setBatchAction(null);
  };

  const confirmDelete = () => {
    setBatchAction("delete");
    setBatchDialogOpen(true);
  };

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
      {/* Batch toolbar */}
      {hasSelection && batchAction && (
        <div className="bg-card border-b p-2 flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {selectedChannels.size} selected
          </span>
          <Select value={String(batchAction ?? "")} onValueChange={(v) => setBatchAction(v as BatchAction)}>
            <SelectTrigger className="h-7 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mode">Change type</SelectItem>
              <SelectItem value="category">Change category</SelectItem>
              <SelectItem value="alerts">Mute / unmute</SelectItem>
              <SelectItem value="active">Enable / disable</SelectItem>
              <SelectItem value="label">Block / unblock</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
            </SelectContent>
          </Select>
          {batchAction === "mode" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="batch-kind">Type</Label>
              <Select value={String(batchKind)} onValueChange={(v) => setBatchKind(v as YtKind)}>
                <SelectTrigger className="h-7 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {TYPE_LABEL[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {batchAction === "category" && (
            <div className="flex items-center gap-2">
              <Label>Category</Label>
              <Select value={batchSubdomainId ? String(batchSubdomainId) : "none"} onValueChange={(v) =>
                setBatchSubdomainId(v === "none" ? null : Number(v))}
              >
                <SelectTrigger className="h-7 w-40">
                  <SelectValue />
                </SelectTrigger>
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
          )}
          {batchAction === "alerts" && (
            <div className="flex items-center gap-2">
              <Label>Alerts</Label>
              <Switch checked={batchAlerts} onCheckedChange={setBatchAlerts} />
              <span className="text-xs text-muted-foreground">
                {batchAlerts ? "Receiving alerts" : "Muted"}
              </span>
            </div>
          )}
          {batchAction === "active" && (
            <div className="flex items-center gap-2">
              <Label>State</Label>
              <Switch checked={batchActive} onCheckedChange={setBatchActive} />
              <span className="text-xs text-muted-foreground">
                {batchActive ? "Active" : "Inactive"}
              </span>
            </div>
          )}
          {batchAction === "label" && (
            <div className="flex items-center gap-2">
              <Label>Label</Label>
              <Select value={batchLabel} onValueChange={setBatchLabel}>
                <SelectTrigger className="h-7 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="reserved">Reserved</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                </SelectContent>
              </Select>
              {batchLabel === "blocked" && (
                <Input
                  value={batchLabelReason}
                  onChange={(e) => setBatchLabelReason(e.target.value)}
                  placeholder="Reason"
                  className="h-7 w-24 text-xs"
                />
              )}
            </div>
          )}
          <Button size="sm" onClick={applyBatch} disabled={!batchAction}>
            Apply
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSelectedChannels(new Set())}>
            Deselect all
          </Button>
        </div>
      )}

      <div className="grid grid-cols-[50px_1fr_130px_150px_110px_50px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground max-lg:grid-cols-[50px_1fr_50px]">
        <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" />
        <span>Source</span>
        <span>Type</span>
        <span>Category</span>
        <span className="text-right">Status</span>
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
          selected={selectedChannels.has(channel.id)}
          onSelect={toggleChannel}
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
  selected,
  onSelect,
}: {
  channel: YtChannel;
  open: boolean;
  onToggle: () => void;
  act: ReturnType<typeof useApp>["act"];
  workspace: ReturnType<typeof useWorkspace>;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const [words, setWords] = useState(channel.words.join(", "));
  const [rank, setRank] = useState(channel.rank ?? "week");
  const [withhold, setWithhold] = useState(channel.withholdThreshold ?? 2);

  const muted = channel.label === "reserved" || channel.alerts === false;
  const status = channel.label === "blocked" ? "Blocked" : muted ? "Muted" : "Live";
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
        "grid grid-cols-[50px_1fr_130px_150px_110px_50px] items-center gap-2 border-b px-3 py-2.5 max-lg:grid-cols-[50px_1fr_50px]",
        open && "bg-accent/40",
      )}>
        <Checkbox checked={selected} onCheckedChange={() => onSelect(channel.id)} />
        <div className={cn(
          "flex min-w-0 items-center gap-2.5 cursor-pointer",
          open && "bg-accent/20 rounded-md p-1",
        )} onClick={onToggle} role="button" tabIndex={0} aria-label={`Edit ${channel.name}`}>
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
            <SelectTrigger className="h-8" aria-label={`Label type for ${channel.name}`}>
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
          {muted ? (
            <Badge variant="outline" className="gap-1 text-[10px]"><BellOff size={9} /> muted</Badge>
          ) : (
            <Badge
              variant={status === "Live" ? "secondary" : status === "Muted" ? "outline" : "destructive"}
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
              <Label>Label type</Label>
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
                        () =>
                          api.ytSetMode(
                            channel.id,
                            "wordscan",
                            words.split(",").map((word) => word.trim()).filter(Boolean),
                          ),
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
                  void act(() => api.ytAssignChannel(channel.id, value === "none" ? null : Number(value)), "Category attached")}
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
              <Label>Alert state</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  checked={!muted}
                  aria-label={muted ? "Unmute channel" : "Mute channel"}
                  onCheckedChange={(next) => void act(() => api.ytSetActive(channel.id, next))}
                />
                <span className="text-xs text-muted-foreground">
                  {muted ? "Muted — still subscribed, receiving nothing" : "Receiving"}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
            <Badge variant="outline" className="gap-1 text-[10px]">
              {channel.alertsEnabled ? <BellRing size={9} className="text-emerald-500" /> : <BellOff size={9} />}
              effective {channel.alertsEnabled ? "on" : "off"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {channel.alertsEnabled ? "Delivered through the alert lane." : "Any parent scope or this channel is muted."}
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
