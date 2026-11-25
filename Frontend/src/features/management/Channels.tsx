import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  BellOff,
  BellRing,
  ChevronDown,
  ExternalLink,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import * as api from "../../app/api";
import { useApp, useWorkspace } from "../../app/state";
import { ConfirmButton, EmptyState } from "../../app/ui";
import { Switch } from "@/components/ui/switch";
import type { YtChannel, YtKind } from "../../lib/types";
import { cn } from "@/lib/utils";
import { parseWordscanTerms } from "@/lib/wordscan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

function batchCount<Result extends object, Key extends keyof Result>(
  result: Result,
  key: Key,
): number {
  const count = result[key];
  if (typeof count !== "number")
    throw new Error(`Batch mutation response is missing ${String(key)}`);
  return count;
}

type Props = { search: string; filter: "all" | "muted"; onAdd: () => void };

type BatchAction = "mode" | "category" | "alerts" | "active" | "label" | "delete";

export default function Channels({ search, filter, onAdd }: Props) {
  const { act, notify } = useApp();
  const workspace = useWorkspace();
  const [openId, setOpenId] = useState<number | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());
  const [batchAction, setBatchAction] = useState<BatchAction | null>(null);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [isApplyingBatch, setIsApplyingBatch] = useState(false);

  // Batch action config state
  const [batchKind, setBatchKind] = useState<YtKind>("tracking");
  const [batchWords, setBatchWords] = useState("");
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
          ? `${channel.name} ${channel.url} ${channel.domain} ${channel.subdomain} ${channel.kind}`
              .toLowerCase()
              .includes(query)
          : true,
      );
  }, [filter, search, workspace.ytChannels]);

  const allSelected = rows.length > 0 && rows.every((row) => selectedChannels.has(row.id));
  const someSelected = rows.some((row) => selectedChannels.has(row.id));

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
      setSelectedChannels((previous) => {
        const next = new Set(previous);
        rows.forEach((row) => next.delete(row.id));
        return next;
      });
    } else {
      setSelectedChannels((previous) => new Set([...previous, ...rows.map((row) => row.id)]));
    }
  };

  const hasSelection = selectedChannels.size > 0;
  const batchWordList = parseWordscanTerms(batchWords);
  const batchReady = Boolean(
    batchAction &&
    !(batchAction === "mode" && batchKind === "wordscan" && batchWordList.length === 0),
  );

  const applyCountBatch = async (
    ids: number[],
    operation: () => Promise<number>,
    successMessage: string,
  ) => {
    let changed = 0;
    const requestSucceeded = await act(async () => {
      changed = await operation();
    });
    if (!requestSucceeded) return false;
    if (changed !== ids.length) {
      const updated = Math.max(0, Math.min(changed, ids.length));
      const deleting = batchAction === "delete";
      if (deleting) {
        setSelectedChannels(new Set());
        setBatchAction(null);
        setBatchDialogOpen(false);
      }
      notify(
        `${updated} of ${ids.length} selected sources ${deleting ? "deleted" : "updated"}; ${ids.length - updated} could not be changed. ${deleting ? "Reselect any remaining sources before retrying." : "Review the selection and try again."}`,
        updated ? "info" : "error",
      );
      return false;
    }
    notify(successMessage, "ok");
    return true;
  };

  const applyBatch = async () => {
    if (!batchAction || !selectedChannels.size || isApplyingBatch || !batchReady) return;
    const ids = Array.from(selectedChannels);
    let succeeded = false;

    setIsApplyingBatch(true);
    try {
      switch (batchAction) {
        case "mode":
          succeeded = await applyCountBatch(
            ids,
            () =>
              api
                .ytBatchSetMode(
                  ids,
                  batchKind,
                  batchKind === "wordscan" ? batchWordList : [],
                  batchKind === "random" ? batchRank : undefined,
                  batchKind === "withhold" ? batchWithhold : undefined,
                )
                .then((result) => batchCount(result, "ytBatchSetMode")),
            `${ids.length} sources switched to ${TYPE_LABEL[batchKind]}`,
          );
          break;
        case "category":
          succeeded = await applyCountBatch(
            ids,
            () =>
              api
                .ytBatchAssignChannel(ids, batchSubdomainId)
                .then((result) => batchCount(result, "ytBatchAssignChannel")),
            `${ids.length} sources recategorised`,
          );
          break;
        case "alerts":
          succeeded = await applyCountBatch(
            ids,
            () =>
              api
                .ytBatchSetAlerts(ids, batchAlerts)
                .then((result) => batchCount(result, "ytBatchSetAlerts")),
            `${ids.length} sources updated`,
          );
          break;
        case "active":
          succeeded = await applyCountBatch(
            ids,
            () =>
              api
                .ytBatchSetActive(ids, batchActive)
                .then((result) => batchCount(result, "ytBatchSetActive")),
            `${ids.length} sources updated`,
          );
          break;
        case "label":
          succeeded = await applyCountBatch(
            ids,
            () =>
              api
                .ytBatchSetLabel(ids, batchLabel, batchLabelReason || undefined)
                .then((result) => batchCount(result, "ytBatchSetLabel")),
            `${ids.length} sources labelled`,
          );
          break;
        case "delete":
          succeeded = await applyCountBatch(
            ids,
            () =>
              api
                .ytBatchDeleteChannel(ids)
                .then((result) => batchCount(result, "ytBatchDeleteChannel")),
            `${ids.length} sources deleted`,
          );
          break;
      }
    } finally {
      setIsApplyingBatch(false);
    }

    if (succeeded) {
      setSelectedChannels(new Set());
      setBatchAction(null);
      setBatchDialogOpen(false);
    }
  };

  if (!workspace.ytChannels.length) {
    return (
      <EmptyState
        title="No sources yet"
        hint="Add a YouTube channel or playlist link — the backend resolves it."
        action={
          <Button size="sm" onClick={onAdd}>
            Add source
          </Button>
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      {/* Batch toolbar */}
      {hasSelection && (
        <div
          className="flex flex-wrap items-center gap-2 border-b bg-card p-2"
          role="toolbar"
          aria-label="Batch source actions"
        >
          <span className="text-xs font-medium text-muted-foreground" aria-live="polite">
            {selectedChannels.size} selected
          </span>
          <Select
            disabled={isApplyingBatch}
            value={batchAction ?? "choose"}
            onValueChange={(value) =>
              setBatchAction(value === "choose" ? null : (value as BatchAction))
            }
          >
            <SelectTrigger className="h-8 w-40" aria-label="Choose batch action">
              <SelectValue placeholder="Choose action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="choose">Choose action</SelectItem>
              <SelectItem value="mode">Change type</SelectItem>
              <SelectItem value="category">Change category</SelectItem>
              <SelectItem value="alerts">Mute / unmute</SelectItem>
              <SelectItem value="active">Enable / disable</SelectItem>
              <SelectItem value="label">Set label</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
            </SelectContent>
          </Select>
          {batchAction === "mode" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="batch-kind">Type</Label>
              <Select
                disabled={isApplyingBatch}
                value={String(batchKind)}
                onValueChange={(v) => setBatchKind(v as YtKind)}
              >
                <SelectTrigger id="batch-kind" className="h-7 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
                    <SelectItem key={kind} value={kind} disabled={kind === "playlist"}>
                      {kind === "playlist" ? "Playlist (re-subscribe required)" : TYPE_LABEL[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {batchAction === "mode" && batchKind === "wordscan" && (
            <div className="flex min-w-56 flex-col gap-1">
              <Label htmlFor="batch-words">Terms</Label>
              <Input
                id="batch-words"
                value={batchWords}
                onChange={(event) => setBatchWords(event.target.value)}
                placeholder="comma, separated"
                aria-describedby="batch-words-hint"
                className="h-8 min-w-32"
                disabled={isApplyingBatch}
              />
              <p id="batch-words-hint" className="text-xs text-muted-foreground">
                {batchWordList.length
                  ? "These non-empty terms apply to every selected source."
                  : "Enter at least one non-empty term before applying."}
              </p>
            </div>
          )}
          {batchAction === "mode" && batchKind === "random" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="batch-rank">Frequency</Label>
              <Select disabled={isApplyingBatch} value={batchRank} onValueChange={setBatchRank}>
                <SelectTrigger id="batch-rank" className="h-7 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {batchAction === "mode" && batchKind === "withhold" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="batch-withhold">Threshold</Label>
              <Input
                id="batch-withhold"
                type="number"
                min={1}
                value={batchWithhold}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) setBatchWithhold(Math.max(1, Math.round(value)));
                }}
                className="h-7 w-20"
                disabled={isApplyingBatch}
              />
            </div>
          )}
          {batchAction === "category" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="batch-category">Category</Label>
              <Select
                disabled={isApplyingBatch}
                value={batchSubdomainId ? String(batchSubdomainId) : "none"}
                onValueChange={(v) => setBatchSubdomainId(v === "none" ? null : Number(v))}
              >
                <SelectTrigger id="batch-category" className="h-7 w-40">
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
              <Switch
                disabled={isApplyingBatch}
                checked={batchAlerts}
                onCheckedChange={setBatchAlerts}
                aria-label="Receive alerts for selected sources"
              />
              <span className="text-xs text-muted-foreground">
                {batchAlerts ? "Receiving alerts" : "Muted"}
              </span>
            </div>
          )}
          {batchAction === "active" && (
            <div className="flex items-center gap-2">
              <Label>State</Label>
              <Switch
                disabled={isApplyingBatch}
                checked={batchActive}
                onCheckedChange={setBatchActive}
                aria-label="Set selected sources active"
              />
              <span className="text-xs text-muted-foreground">
                {batchActive ? "Active" : "Inactive"}
              </span>
            </div>
          )}
          {batchAction === "label" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="batch-label">Label</Label>
              <Select disabled={isApplyingBatch} value={batchLabel} onValueChange={setBatchLabel}>
                <SelectTrigger id="batch-label" className="h-7 w-24">
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
                  aria-label="Reason for blocking selected sources"
                  className="h-7 w-24 text-xs"
                  disabled={isApplyingBatch}
                />
              )}
            </div>
          )}
          <Button
            size="sm"
            variant={batchAction === "delete" ? "destructive" : "default"}
            onClick={() =>
              batchAction === "delete" ? setBatchDialogOpen(true) : void applyBatch()
            }
            disabled={!batchReady || isApplyingBatch}
          >
            {isApplyingBatch ? "Applying…" : batchAction === "delete" ? "Review delete" : "Apply"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedChannels(new Set())}
            disabled={isApplyingBatch}
          >
            Deselect all
          </Button>
        </div>
      )}

      <div className="grid grid-cols-[50px_1fr_130px_150px_110px_50px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground max-lg:grid-cols-[50px_1fr_50px]">
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={toggleAll}
          aria-label="Select all visible sources"
          disabled={isApplyingBatch}
        />
        <span>Source</span>
        <span>Type</span>
        <span>Category</span>
        <span className="text-right">Status</span>
      </div>
      {rows.length === 0 && (
        <EmptyState title="No sources match" hint="Try clearing the search or filter." />
      )}
      {rows.map((channel) => (
        <ChannelRow
          key={channel.id}
          channel={channel}
          open={openId === channel.id}
          onToggle={() => setOpenId(openId === channel.id ? null : channel.id)}
          act={act}
          workspace={workspace}
          selected={selectedChannels.has(channel.id)}
          disabled={isApplyingBatch}
          onSelect={toggleChannel}
          onDelete={() => {
            setSelectedChannels((previous) => {
              if (!previous.has(channel.id)) return previous;
              const next = new Set(previous);
              next.delete(channel.id);
              return next;
            });
            if (selectedChannels.size === 1 && selectedChannels.has(channel.id)) {
              setBatchAction(null);
            }
          }}
        />
      ))}
      <Dialog
        open={batchDialogOpen}
        onOpenChange={(open) => !isApplyingBatch && setBatchDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete selected sources?</DialogTitle>
            <DialogDescription>
              This permanently removes {selectedChannels.size} selected source
              {selectedChannels.size === 1 ? "" : "s"} from your management list. This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchDialogOpen(false)}
              disabled={isApplyingBatch}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void applyBatch()}
              disabled={isApplyingBatch || !selectedChannels.size}
            >
              {isApplyingBatch ? "Deleting…" : "Delete sources"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  disabled,
  onSelect,
  onDelete,
}: {
  channel: YtChannel;
  open: boolean;
  onToggle: () => void;
  act: ReturnType<typeof useApp>["act"];
  workspace: ReturnType<typeof useWorkspace>;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: number) => void;
  onDelete: () => void;
}) {
  const serverWords = channel.words.join(", ");
  const serverRank = channel.rank ?? "week";
  const serverWithhold = channel.withholdThreshold ?? 2;
  const [words, setWords] = useState(serverWords);
  const [rank, setRank] = useState(serverRank);
  const [withhold, setWithhold] = useState(serverWithhold);
  const [wordscanDraft, setWordscanDraft] = useState(false);
  const wordscanTerms = parseWordscanTerms(words);

  useEffect(() => {
    setWords(serverWords);
    setRank(serverRank);
    setWithhold(serverWithhold);
    setWordscanDraft(false);
  }, [channel.id, channel.kind, serverWords, serverRank, serverWithhold]);

  const muted = channel.label === "reserved" || channel.alerts === false;
  const status = channel.label === "blocked" ? "Blocked" : muted ? "Muted" : "Live";
  // Withhold is a tracking row with a threshold — display it as its own type.
  const displayKind: YtKind = wordscanDraft
    ? "wordscan"
    : channel.withholdThreshold
      ? "withhold"
      : (channel.kind ?? "tracking");

  const typeSelect = (kind: YtKind) => {
    if (kind === "wordscan" && !wordscanTerms.length) {
      if (!open) onToggle();
      setWordscanDraft(true);
      return;
    }
    setWordscanDraft(false);
    void act(() =>
      api.ytSetMode(
        channel.id,
        kind,
        kind === "wordscan" ? wordscanTerms : undefined,
        kind === "random" ? rank : undefined,
        kind === "withhold" ? withhold : undefined,
      ),
    );
  };

  return (
    <>
      <div
        className={cn(
          "grid grid-cols-[50px_1fr_130px_150px_110px_50px] items-center gap-2 border-b px-3 py-2.5 max-lg:grid-cols-[50px_1fr_50px]",
          open && "bg-accent/40",
        )}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={() => onSelect(channel.id)}
          aria-label={`Select ${channel.name ?? "source"}`}
          disabled={disabled}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-auto w-full min-w-0 justify-start gap-2.5 rounded-md px-1 py-1 text-left shadow-none",
            open && "bg-accent/20",
          )}
          onClick={onToggle}
          aria-label={`Edit ${channel.name ?? "source"}`}
          disabled={disabled}
        >
          {channel.logo ? (
            <img
              className="h-8 w-8 shrink-0 rounded-full object-cover"
              src={channel.logo}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold">
              {(channel.name ?? "?").slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{channel.name ?? "Unknown channel"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {channel.rssId ?? channel.url}
            </div>
          </div>
        </Button>

        <div className="max-lg:hidden">
          <Select
            disabled={disabled}
            value={displayKind}
            onValueChange={(value) => void typeSelect(value as YtKind)}
          >
            <SelectTrigger className="h-8" aria-label={`Label type for ${channel.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
                <SelectItem
                  key={kind}
                  value={kind}
                  disabled={kind === "playlist" && channel.kind !== "playlist"}
                >
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
            <Badge variant="outline" className="gap-1 text-[10px]">
              <BellOff size={9} /> muted
            </Badge>
          ) : (
            <Badge
              variant={
                status === "Live" ? "secondary" : status === "Muted" ? "outline" : "destructive"
              }
              className="text-[10px]"
            >
              {status}
            </Badge>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={open ? "Close editor" : "Edit source"}
            title="Edit"
            onClick={onToggle}
            disabled={disabled}
          >
            <SlidersHorizontal size={14} />
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-b bg-muted/30 px-4 py-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Label type</Label>
              <Select
                disabled={disabled}
                value={displayKind}
                onValueChange={(value) => void typeSelect(value as YtKind)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABEL) as YtKind[]).map((kind) => (
                    <SelectItem
                      key={kind}
                      value={kind}
                      disabled={kind === "playlist" && channel.kind !== "playlist"}
                    >
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
                    disabled={disabled}
                  />
                  <Button
                    size="sm"
                    disabled={disabled}
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

            {displayKind === "wordscan" && (
              <div className="space-y-1.5">
                <Label htmlFor={`wordscan-terms-${channel.id}`}>WordScan terms</Label>
                <div className="flex gap-2">
                  <Input
                    id={`wordscan-terms-${channel.id}`}
                    value={words}
                    onChange={(event) => setWords(event.target.value)}
                    placeholder="comma, separated"
                    aria-describedby={`wordscan-hint-${channel.id}`}
                    disabled={disabled}
                  />
                  <Button
                    size="sm"
                    disabled={disabled || !wordscanTerms.length}
                    onClick={() => {
                      void act(
                        () => api.ytSetMode(channel.id, "wordscan", wordscanTerms),
                        "WordScan terms saved",
                      ).then((ok) => ok && setWordscanDraft(false));
                    }}
                  >
                    Apply
                  </Button>
                </div>
                <p id={`wordscan-hint-${channel.id}`} className="text-xs text-muted-foreground">
                  {wordscanTerms.length
                    ? "Comma-separated terms are matched against video titles."
                    : "Enter at least one non-empty term before saving."}
                </p>
              </div>
            )}

            {channel.kind === "random" && (
              <div className="space-y-1.5">
                <Label>Frequency</Label>
                <div className="flex gap-2">
                  <Select disabled={disabled} value={rank} onValueChange={setRank}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FREQUENCIES.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      void act(
                        () => api.ytSetMode(channel.id, "random", undefined, rank),
                        "Frequency saved",
                      )
                    }
                  >
                    Apply
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Attach to domain</Label>
              <Select
                disabled={disabled}
                value={channel.subdomainId ? String(channel.subdomainId) : "none"}
                onValueChange={(value) =>
                  void act(
                    () => api.ytAssignChannel(channel.id, value === "none" ? null : Number(value)),
                    "Category attached",
                  )
                }
              >
                <SelectTrigger>
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

            <div className="space-y-1.5">
              <Label>Alert state</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  checked={!muted}
                  aria-label={muted ? "Unmute channel" : "Mute channel"}
                  onCheckedChange={(next) => void act(() => api.ytSetActive(channel.id, next))}
                  disabled={disabled}
                />
                <span className="text-xs text-muted-foreground">
                  {muted ? "Muted — still subscribed, receiving nothing" : "Receiving"}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
            <Badge variant="outline" className="gap-1 text-[10px]">
              {channel.alertsEnabled ? (
                <BellRing size={9} className="text-emerald-500" />
              ) : (
                <BellOff size={9} />
              )}
              effective {channel.alertsEnabled ? "on" : "off"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {channel.alertsEnabled
                ? "Delivered through the alert lane."
                : "Any parent scope or this channel is muted."}
            </span>
            <span className="grow" />
            {channel.url && (
              <Button variant="ghost" size="sm" asChild disabled={disabled}>
                <a href={channel.url} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} /> Open
                </a>
              </Button>
            )}
            {channel.label !== "blocked" && (
              <Button
                variant="destructive"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  void act(
                    () => api.ytSetLabel(channel.id, "blocked", "Blocked from management"),
                    "Source blocked",
                  )
                }
              >
                <Ban size={12} /> Block
              </Button>
            )}
            <ConfirmButton
              label={`Delete ${channel.name}`}
              className="h-8 w-8"
              disabled={disabled}
              onConfirm={() => {
                void act(() => api.ytDeleteChannel(channel.id), "Source deleted").then((ok) => {
                  if (ok) onDelete();
                });
              }}
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
