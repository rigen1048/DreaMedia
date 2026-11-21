import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, DatabaseBackup, Download, HardDriveDownload, KeyRound, Loader2,
  SlidersHorizontal, RotateCcw, ShieldCheck, Trash2, Upload, Users,
} from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import { ConfirmButton, EmptyState } from "../../app/ui";
import { formatDate, plural, timeAgo } from "../../lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FileButton } from "@/components/ui/file-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const TABS = [
  { key: "backups", label: "Backups", icon: DatabaseBackup },
  { key: "restore", label: "Restore", icon: RotateCcw },
  { key: "settings", label: "Settings", icon: SlidersHorizontal },
  { key: "users", label: "Users", icon: Users },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const PHASE_LABEL: Record<string, string> = {
  idle: "No restore yet", queued: "Queued", snapshot: "Writing rollback snapshot",
  restoring: "Restoring database", rollback: "Rolling back",
  done: "Restore complete", failed: "Restore failed",
};

const SETTING_LABEL: Record<string, { label: string; hint: string }> = {
  backup_dir: { label: "Backup directory", hint: "Inside the backend container (/backups by default)" },
  backup_keep_latest: { label: "Dumps to keep", hint: "Older dumps are pruned after each backup" },
  backup_frequency_hours: { label: "Backup every (hours)", hint: "The scheduler re-reads this every cycle" },
  stale_claim_seconds: { label: "Stale claim (seconds)", hint: "Recovery window for interrupted fetches" },
};

function bytes(size: number): string {
  if (size > 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size > 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size > 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

export default function Admin() {
  const { viewer, act, notify } = useApp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("backups");
  const [status, setStatus] = useState<api.RestoreStatus | null>(null);
  const [staged, setStaged] = useState<{ file: string; size: number } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const admin = useQuery({ queryKey: ["admin"], queryFn: api.fetchAdmin, retry: false });
  const data = admin.data;

  useEffect(() => {
    if (data) setStatus(data.adminOverview.restore);
  }, [data]);

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  const run = async (label: string, operation: () => Promise<unknown>, done: string) => {
    setBusy(label);
    const ok = await act(operation, done);
    setBusy(null);
    if (ok) await reload();
    return ok;
  };

  const active = Boolean(status?.active);
  const tracking = useRef(false);

  const trackRestore = async () => {
    if (tracking.current) return;
    tracking.current = true;
    try {
      for (let attempt = 0; attempt < 900; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        let next: api.RestoreStatus;
        try {
          next = await api.fetchRestoreStatus();
        } catch {
          window.location.assign("/");
          return;
        }
        setStatus(next);
        if (next.active) continue;
        if (next.phase === "done") {
          notify("Restore complete — every session was signed out. Sign in again.", "ok");
          window.location.assign("/");
          return;
        }
        if (next.phase === "failed") {
          notify(next.error ?? "Restore failed — previous data was kept.", "error");
          await reload();
          return;
        }
      }
    } finally {
      tracking.current = false;
    }
  };

  useEffect(() => {
    if (status?.active) void trackRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.active]);

  const overview = data?.adminOverview;
  const backups = data?.adminBackups ?? [];
  const settings = data?.adminSettings ?? [];
  const users = data?.adminUsers ?? [];
  const chosen = staged?.file ?? target;

  const latest = useMemo(() => {
    if (!backups.length) return "none yet";
    return `${timeAgo(backups[0].mtime)} · ${bytes(backups[0].size)}`;
  }, [backups]);

  if (admin.isPending) {
    return <EmptyState title="Loading admin" hint="Reading settings, backups and users from the backend." />;
  }

  if (admin.error) {
    return (
      <EmptyState
        title="Admin unavailable"
        hint={admin.error instanceof Error ? admin.error.message : "The backend refused this request. Sign in as an admin."}
        action={<Button size="sm" onClick={() => void admin.refetch()}>Retry</Button>}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            Admin <Badge variant="secondary" className="gap-1"><ShieldCheck size={11} /> {viewer?.username}</Badge>
          </h1>
          <p className="text-xs text-muted-foreground">Backups, restore, runtime settings and accounts — this box, all users.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">
            <b className="text-foreground">{overview?.backupCount ?? 0}</b> {plural(overview?.backupCount ?? 0, "dump")} · latest {latest} ·{" "}
            <b className="text-foreground">{overview?.userCount ?? 0}</b> {plural(overview?.userCount ?? 0, "user")} ·{" "}
            <b className="text-foreground">{overview?.adminCount ?? 0}</b> {plural(overview?.adminCount ?? 0, "admin")}
          </div>
          <Button size="sm" disabled={busy === "backup"} onClick={() => void run("backup", () => api.adminRunBackup(), "Backup written")}>
            {busy === "backup" ? <Loader2 size={13} className="animate-spin" /> : <HardDriveDownload size={13} />}
            Back up now
          </Button>
        </div>
      </div>

      {(active || status?.phase === "failed" || status?.phase === "done") && (
        <div
          className={cn(
            "space-y-2 rounded-xl border p-3",
            status?.phase === "failed" ? "border-destructive/50 bg-destructive/10" : active ? "border-sky-500/40 bg-sky-500/10" : "border-emerald-500/40 bg-emerald-500/10",
          )}
        >
          <div className="flex items-center gap-2 text-sm">
            {active ? <Loader2 size={14} className="animate-spin" /> : status?.phase === "failed" ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
            <strong>{PHASE_LABEL[status?.phase ?? "idle"] ?? status?.phase}</strong>
            {status?.file && <code className="text-xs">{status.file}</code>}
            <span className="grow" />
            {status?.message && <span className="text-xs text-muted-foreground">{status.message}</span>}
          </div>
          {active && (
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-500" />
            </div>
          )}
          {status?.error && <p className="text-xs text-destructive">{status.error}</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <Button
              key={item.key}
              variant="ghost"
              size="sm"
              onClick={() => setTab(item.key)}
              className={cn(
                "h-auto gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                tab === item.key ? "bg-primary text-primary-foreground border-transparent hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground",
              )}
            >
              <Icon size={12} /> {item.label}
              {item.key === "backups" && <span className="opacity-60">{backups.length}</span>}
              {item.key === "users" && <span className="opacity-60">{users.length}</span>}
            </Button>
          );
        })}
      </div>

      {tab === "backups" && (
        <div className="overflow-hidden rounded-xl border">
          <div className="grid grid-cols-[1fr_80px_180px_140px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>Dump</span><span>Size</span><span>Created</span><span className="text-right">Actions</span>
          </div>
          {backups.length === 0 && (
            <EmptyState
              title="No backups yet"
              hint="The scheduler writes one every few hours; you can also take one now."
              action={<Button size="sm" onClick={() => void run("backup", () => api.adminRunBackup(), "Backup written")}>Back up now</Button>}
            />
          )}
          {backups.map((row) => (
            <div key={row.file} className="grid grid-cols-[1fr_80px_180px_140px] items-center gap-2 border-b px-3 py-2 text-sm last:border-0">
              <code className="truncate text-xs">{row.file}</code>
              <span className="text-xs">{bytes(row.size)}</span>
              <span className="text-xs text-muted-foreground">{formatDate(row.mtime)} · {timeAgo(row.mtime)}</span>
              <span className="flex justify-end gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" title="Download dump" aria-label={`Download ${row.file}`} asChild>
                  <a href={api.backupDownloadUrl(row.file)}><Download size={13} /></a>
                </Button>
                <Button size="sm" variant="secondary" onClick={() => { setTarget(row.file); setStaged(null); setTyped(""); setTab("restore"); }}>
                  <RotateCcw size={12} /> Restore
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === "restore" && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="border-destructive/40">
            <CardHeader className="space-y-1 p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-destructive">
                <AlertTriangle size={14} /> Restore replaces the database
              </h2>
              <p className="text-xs text-muted-foreground">
                Every account, channel, anime entry and message is replaced by the dump you pick.
                A rollback snapshot is written first, workers pause for the whole run, and every
                session is signed out when it finishes — including yours.
              </p>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              <FileButton
                variant="outline"
                accept=".dump,application/octet-stream"
                className="flex h-auto w-full items-center justify-start gap-3 rounded-xl border-dashed p-4 text-sm whitespace-normal"
                onFile={async (file) => {
                  setBusy("upload");
                  try {
                    const saved = await api.uploadRestoreDump(file);
                    setStaged(saved);
                    setTarget(null);
                    setTyped("");
                    notify(`Uploaded ${saved.file} — validated as a pg_dump archive`, "ok");
                    await reload();
                  } catch (error) {
                    notify(error instanceof Error ? error.message : "Upload rejected", "error");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "upload" ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} className="text-muted-foreground" />}
                <span>
                  <strong className="block">Upload a .dump from your computer</strong>
                  <em className="text-xs not-italic text-muted-foreground">Validated with pg_restore -l before it is accepted; nothing is restored yet.</em>
                </span>
              </FileButton>

              <div className="space-y-1.5">
                <span className="text-xs font-medium">Or pick a dump already on this box</span>
                <Select
                  value={target ?? "none"}
                  onValueChange={(value) => { setTarget(value === "none" ? null : value); setStaged(null); setTyped(""); }}
                >
                  <SelectTrigger><SelectValue placeholder="Choose a backup…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Choose a backup…</SelectItem>
                    {backups.map((row) => (
                      <SelectItem key={row.file} value={row.file}>{row.file} · {bytes(row.size)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
                <div>
                  <strong className="text-sm">{chosen ?? "nothing selected"}</strong>
                  <p className="text-xs text-muted-foreground">
                    Type <b>RESTORE</b> to enable the button. This cannot be undone from the UI —
                    the rollback snapshot is the way back.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder="RESTORE"
                    aria-label="Type RESTORE to confirm"
                    className="w-36"
                  />
                  <Button
                    variant="destructive"
                    disabled={!chosen || typed.trim().toUpperCase() !== "RESTORE" || active || busy === "restore"}
                    onClick={async () => {
                      if (!chosen) return;
                      const started = await run("restore", () => api.adminStartRestore(chosen), "Restore started — workers paused");
                      if (started) {
                        setTyped("");
                        setStatus({
                          phase: "queued", active: true, file: chosen,
                          startedAt: Date.now() / 1000, finishedAt: null,
                          snapshot: null, error: null,
                          message: "restore accepted — workers paused", sessionsDropped: 0,
                        });
                        void trackRestore();
                      }
                    }}
                  >
                    {active ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                    Restore database
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-1 p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><DatabaseBackup size={14} /> Restore points</h2>
              <p className="text-xs text-muted-foreground">
                Newest first. Retention keeps {overview?.keepLatest ?? 2}; a backup runs every {overview?.frequencyHours ?? 24}h.
              </p>
            </CardHeader>
            <CardContent className="space-y-1 p-4 pt-0">
              {backups.length === 0 && <p className="text-sm text-muted-foreground">No dumps on disk yet.</p>}
              {backups.map((row) => (
                <Button
                  key={row.file}
                  variant="ghost"
                  onClick={() => { setTarget(row.file); setStaged(null); setTyped(""); }}
                  className={cn(
                    "flex h-auto w-full items-center justify-start gap-3 rounded-lg border px-3 py-2 text-left whitespace-normal",
                    target === row.file ? "border-sky-500 bg-sky-500/10 hover:bg-sky-500/10" : "",
                  )}
                >
                  <code className="flex-1 truncate text-xs">{row.file}</code>
                  <span className="text-xs">{bytes(row.size)}</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(row.mtime)}</span>
                </Button>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "settings" && (
        <div className="overflow-hidden rounded-xl border">
          <div className="grid grid-cols-[1fr_220px_80px_90px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>Setting</span><span>Value</span><span>Floor</span><span className="text-right">Save</span>
          </div>
          {settings.map((row) => (
            <SettingRow key={row.key} row={row} busy={busy === row.key} onSave={(value) => run(row.key, () => api.adminSetSetting(row.key, value), `${row.key} saved`)} />
          ))}
        </div>
      )}

      {tab === "users" && (
        <>
          <div className="overflow-hidden rounded-xl border">
            <div className="grid grid-cols-[1fr_120px_140px_180px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
              <span>User</span><span>Role</span><span>Created</span><span className="text-right">Actions</span>
            </div>
            {users.map((row) => (
              <UserRow
                key={row.id}
                row={row}
                self={row.id === viewer?.id}
                lastAdmin={row.role === "admin" && (overview?.adminCount ?? 0) <= 1}
                busy={busy === `user-${row.id}`}
                onRole={(role) => run(`user-${row.id}`, () => api.adminSetUserRole(row.id, role), `${row.username} is now ${role}`)}
                onReset={(password) => run(`user-${row.id}`, () => api.adminResetPassword(row.id, password), `Password reset for ${row.username} — their sessions were signed out`)}
                onDelete={() => run(`user-${row.id}`, () => api.adminDeleteUser(row.id), `${row.username} deleted`)}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Locked out completely? Run <code>docker compose exec backend python -m scripts.admin promote &lt;user&gt;</code> on the host —
            that is the only path that does not need an existing admin.
          </p>
        </>
      )}
    </div>
  );
}

function SettingRow({ row, busy, onSave }: { row: api.AdminSetting; busy: boolean; onSave: (value: string) => Promise<boolean> }) {
  const [value, setValue] = useState(row.value);
  useEffect(() => setValue(row.value), [row.value]);
  const meta = SETTING_LABEL[row.key] ?? { label: row.key, hint: "" };
  const dirty = value !== row.value;
  return (
    <div className="grid grid-cols-[1fr_220px_80px_90px] items-center gap-2 border-b px-3 py-2 last:border-0">
      <div>
        <strong className="text-sm">{meta.label}</strong>
        <span className="text-xs text-muted-foreground"> · {row.key}</span>
        {meta.hint && <p className="text-xs text-muted-foreground">{meta.hint}</p>}
      </div>
      <Input value={value} inputMode={row.kind === "int" ? "numeric" : undefined} onChange={(event) => setValue(event.target.value)} aria-label={meta.label} className="h-8" />
      <span className="text-xs text-muted-foreground">{row.floor ? `min ${row.floor}` : "—"}</span>
      <span className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={!dirty || busy} onClick={() => void onSave(value)}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : null} Save
        </Button>
      </span>
    </div>
  );
}

function UserRow({
  row, self, lastAdmin, busy, onRole, onReset, onDelete,
}: {
  row: api.AdminUser;
  self: boolean;
  lastAdmin: boolean;
  busy: boolean;
  onRole: (role: string) => Promise<boolean>;
  onReset: (password: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <div className="grid grid-cols-[1fr_120px_140px_180px] items-center gap-2 border-b px-3 py-2 last:border-0">
      <span className="flex items-center gap-2 text-sm font-medium">
        {row.username}
        {self && <Badge variant="secondary" className="text-[10px]">you</Badge>}
      </span>
      <Select value={row.role} disabled={busy || lastAdmin} onValueChange={(value) => void onRole(value)}>
        <SelectTrigger className="h-8" aria-label={`Role for ${row.username}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">admin</SelectItem>
          <SelectItem value="user">user</SelectItem>
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</span>
      <span className="flex items-center justify-end gap-1">
        {resetting ? (
          <>
            <Input
              className="h-8 w-36"
              value={password}
              autoFocus
              placeholder="new password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setResetting(false);
                if (event.key === "Enter" && password.length >= 6) {
                  void onReset(password).then((ok) => {
                    if (ok) { setResetting(false); setPassword(""); }
                  });
                }
              }}
            />
            <Button
              size="sm" variant="secondary" disabled={password.length < 6 || busy}
              onClick={() =>
                void onReset(password).then((ok) => {
                  if (ok) { setResetting(false); setPassword(""); }
                })
              }
            >
              <KeyRound size={12} /> Set
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="icon" className="h-8 w-8" title={`Reset password for ${row.username}`} aria-label={`Reset password for ${row.username}`} onClick={() => setResetting(true)}>
            <KeyRound size={13} />
          </Button>
        )}
        {!self && (
          <ConfirmButton label={`Delete ${row.username}`} className="h-8 w-8" onConfirm={() => void onDelete()}>
            <Trash2 size={13} />
          </ConfirmButton>
        )}
      </span>
    </div>
  );
}
