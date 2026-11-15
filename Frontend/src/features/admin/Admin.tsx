import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  DatabaseBackup,
  Download,
  HardDriveDownload,
  KeyRound,
  Loader2,
  SlidersHorizontal,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import * as api from "../../app/api";
import { useApp } from "../../app/state";
import { ConfirmButton, EmptyState } from "../../app/ui";
import { formatDate, plural, timeAgo } from "../../lib/format";

const TABS = [
  { key: "backups", label: "Backups", icon: DatabaseBackup },
  { key: "restore", label: "Restore", icon: RotateCcw },
  { key: "settings", label: "Settings", icon: SlidersHorizontal },
  { key: "users", label: "Users", icon: Users },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const PHASE_LABEL: Record<string, string> = {
  idle: "No restore yet",
  queued: "Queued",
  snapshot: "Writing rollback snapshot",
  restoring: "Restoring database",
  rollback: "Rolling back",
  done: "Restore complete",
  failed: "Restore failed",
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
  const { viewer, refresh, act, notify } = useApp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("backups");
  const [status, setStatus] = useState<api.RestoreStatus | null>(null);
  const [staged, setStaged] = useState<{ file: string; size: number } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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

  /* ------------------------------------------------------------ restore poll */
  const active = Boolean(status?.active);
  const tracking = useRef(false);

  /**
   * Follow a restore until it reaches a terminal phase.
   *
   * A loop rather than an interval keyed on `active`: a small database
   * restores in well under a second, so the job can finish between two polls
   * and a "watch the transition" effect would never see it. A full reload is
   * the honest ending — every session was just invalidated, so all client
   * state is stale by definition.
   */
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
          // 401: the restore finished and dropped this session too.
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
    // A restore may already be running when the page opens (another tab, or a
    // reload mid-restore): pick it up from the overview.
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
    return (
      <div className="page">
        <EmptyState title="Loading admin" hint="Reading settings, backups and users from the backend." />
      </div>
    );
  }

  if (admin.error) {
    return (
      <div className="page">
        <EmptyState
          title="Admin unavailable"
          hint={
            admin.error instanceof Error
              ? admin.error.message
              : "The backend refused this request. Sign in as an admin."
          }
          action={
            <button className="btn btn--sm" onClick={() => void admin.refetch()}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__title">
          <h1>
            Admin <span className="badge badge--admin"><ShieldCheck size={11} /> {viewer?.username}</span>
          </h1>
          <p>Backups, restore, runtime settings and accounts — this box, all users.</p>
        </div>
        <div className="page-head__actions">
          <div className="metrics">
            <span><b>{overview?.backupCount ?? 0}</b> {plural(overview?.backupCount ?? 0, "dump")}</span>
            <span className="sep" />
            <span>latest {latest}</span>
            <span className="sep" />
            <span>
              <b>{overview?.userCount ?? 0}</b> {plural(overview?.userCount ?? 0, "user")} ·{" "}
              <b>{overview?.adminCount ?? 0}</b> {plural(overview?.adminCount ?? 0, "admin")}
            </span>
          </div>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy === "backup"}
            onClick={() => void run("backup", () => api.adminRunBackup(), "Backup written")}
          >
            {busy === "backup" ? <Loader2 size={13} className="spin" /> : <HardDriveDownload size={13} />}
            Back up now
          </button>
        </div>
      </div>

      {(active || status?.phase === "failed" || status?.phase === "done") && (
        <div className="restore-banner" data-tone={status?.phase === "failed" ? "error" : active ? "busy" : "ok"}>
          <div className="restore-banner__head">
            {active ? <Loader2 size={14} className="spin" /> : status?.phase === "failed" ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
            <strong>{PHASE_LABEL[status?.phase ?? "idle"] ?? status?.phase}</strong>
            {status?.file && <code>{status.file}</code>}
            <span className="grow" />
            {status?.message && <span className="faint">{status.message}</span>}
          </div>
          {active && <div className="restore-banner__bar" />}
          {status?.error && <p className="restore-banner__error">{status.error}</p>}
        </div>
      )}

      <div className="filterbar" style={{ marginBottom: 12 }}>
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              className="chipbtn"
              data-active={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              <Icon size={12} /> {item.label}
              {item.key === "backups" && <span className="count">{backups.length}</span>}
              {item.key === "users" && <span className="count">{users.length}</span>}
            </button>
          );
        })}
      </div>

      {tab === "backups" && (
        <div className="table">
          <div className="table__head table__head--backups">
            <span>Dump</span>
            <span>Size</span>
            <span>Created</span>
            <span style={{ textAlign: "right" }}>Actions</span>
          </div>
          {backups.length === 0 && (
            <EmptyState
              title="No backups yet"
              hint="The scheduler writes one every few hours; you can also take one now."
              action={
                <button className="btn btn--sm btn--primary" onClick={() => void run("backup", () => api.adminRunBackup(), "Backup written")}>
                  Back up now
                </button>
              }
            />
          )}
          {backups.map((row) => (
            <div className="backup-row" key={row.file}>
              <code className="backup-row__file">{row.file}</code>
              <span>{bytes(row.size)}</span>
              <span className="faint">{formatDate(row.mtime)} · {timeAgo(row.mtime)}</span>
              <span className="cell-actions">
                <a
                  className="icon-btn"
                  href={api.backupDownloadUrl(row.file)}
                  title="Download dump"
                  aria-label={`Download ${row.file}`}
                >
                  <Download size={13} />
                </a>
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    setTarget(row.file);
                    setStaged(null);
                    setTyped("");
                    setTab("restore");
                  }}
                >
                  <RotateCcw size={12} /> Restore
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === "restore" && (
        <div className="admin-grid">
          <section className="panel panel--danger">
            <div className="panel__head">
              <h2><AlertTriangle size={14} /> Restore replaces the database</h2>
              <p>
                Every account, channel, anime entry and message is replaced by the dump you pick.
                A rollback snapshot is written first, workers pause for the whole run, and every
                session is signed out when it finishes — including yours.
              </p>
            </div>

            <div className="panel__body">
              <label className="dropzone">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".dump,application/octet-stream"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
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
                />
                {busy === "upload" ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
                <span>
                  <strong>Upload a .dump from your computer</strong>
                  <em>Validated with pg_restore -l before it is accepted; nothing is restored yet.</em>
                </span>
              </label>

              <div className="field">
                <span>Or pick a dump already on this box</span>
                <select
                  className="select"
                  value={target ?? ""}
                  onChange={(event) => {
                    setTarget(event.target.value || null);
                    setStaged(null);
                    setTyped("");
                  }}
                >
                  <option value="">Choose a backup…</option>
                  {backups.map((row) => (
                    <option key={row.file} value={row.file}>
                      {row.file} · {bytes(row.size)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="restore-confirm">
                <div>
                  <strong>{chosen ?? "nothing selected"}</strong>
                  <p className="faint">
                    Type <b>RESTORE</b> to enable the button. This cannot be undone from the UI —
                    the rollback snapshot is the way back.
                  </p>
                </div>
                <input
                  className="input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder="RESTORE"
                  aria-label="Type RESTORE to confirm"
                  style={{ width: 150 }}
                />
                <button
                  className="btn btn--danger"
                  disabled={!chosen || typed.trim().toUpperCase() !== "RESTORE" || active || busy === "restore"}
                  onClick={async () => {
                    if (!chosen) return;
                    const started = await run(
                      "restore",
                      () => api.adminStartRestore(chosen),
                      "Restore started — workers paused",
                    );
                    if (started) {
                      setTyped("");
                      setStatus({
                        phase: "queued",
                        active: true,
                        file: chosen,
                        startedAt: Date.now() / 1000,
                        finishedAt: null,
                        snapshot: null,
                        error: null,
                        message: "restore accepted — workers paused",
                        sessionsDropped: 0,
                      });
                      void trackRestore();
                    }
                  }}
                >
                  {active ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
                  Restore database
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h2><DatabaseBackup size={14} /> Restore points</h2>
              <p>Newest first. Retention keeps {overview?.keepLatest ?? 2}; a backup runs every {overview?.frequencyHours ?? 24}h.</p>
            </div>
            <div className="panel__body panel__body--list">
              {backups.length === 0 && <p className="faint">No dumps on disk yet.</p>}
              {backups.map((row) => (
                <button
                  key={row.file}
                  className="pick-row"
                  data-active={target === row.file}
                  onClick={() => {
                    setTarget(row.file);
                    setStaged(null);
                    setTyped("");
                  }}
                >
                  <code>{row.file}</code>
                  <span>{bytes(row.size)}</span>
                  <span className="faint">{timeAgo(row.mtime)}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "settings" && (
        <div className="table">
          <div className="table__head table__head--settings">
            <span>Setting</span>
            <span>Value</span>
            <span>Floor</span>
            <span style={{ textAlign: "right" }}>Save</span>
          </div>
          {settings.map((row) => (
            <SettingRow
              key={row.key}
              row={row}
              busy={busy === row.key}
              onSave={(value) => run(row.key, () => api.adminSetSetting(row.key, value), `${row.key} saved`)}
            />
          ))}
        </div>
      )}

      {tab === "users" && (
        <>
          <div className="table">
            <div className="table__head table__head--users">
              <span>User</span>
              <span>Role</span>
              <span>Created</span>
              <span style={{ textAlign: "right" }}>Actions</span>
            </div>
            {users.map((row) => (
              <UserRow
                key={row.id}
                row={row}
                self={row.id === viewer?.id}
                lastAdmin={row.role === "admin" && (overview?.adminCount ?? 0) <= 1}
                busy={busy === `user-${row.id}`}
                onRole={(role) => run(`user-${row.id}`, () => api.adminSetUserRole(row.id, role), `${row.username} is now ${role}`)}
                onReset={(password) =>
                  run(`user-${row.id}`, () => api.adminResetPassword(row.id, password), `Password reset for ${row.username} — their sessions were signed out`)
                }
                onDelete={() => run(`user-${row.id}`, () => api.adminDeleteUser(row.id), `${row.username} deleted`)}
              />
            ))}
          </div>
          <p className="admin-footnote">
            Locked out completely? Run <code>docker compose exec backend python -m scripts.admin promote &lt;user&gt;</code>
            {" "}on the host — that is the only path that does not need an existing admin.
          </p>
        </>
      )}
    </div>
  );
}

function SettingRow({
  row,
  busy,
  onSave,
}: {
  row: api.AdminSetting;
  busy: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(row.value);
  useEffect(() => setValue(row.value), [row.value]);
  const meta = SETTING_LABEL[row.key] ?? { label: row.key, hint: "" };
  const dirty = value !== row.value;
  return (
    <div className="setting-row">
      <div>
        <strong>{meta.label}</strong>
        <span className="faint"> · {row.key}</span>
        {meta.hint && <p className="faint">{meta.hint}</p>}
      </div>
      <input
        className="input"
        value={value}
        inputMode={row.kind === "int" ? "numeric" : undefined}
        onChange={(event) => setValue(event.target.value)}
        aria-label={meta.label}
      />
      <span className="faint">{row.floor ? `min ${row.floor}` : "—"}</span>
      <span className="cell-actions">
        <button
          className="btn btn--sm"
          disabled={!dirty || busy}
          onClick={() => void onSave(value)}
        >
          {busy ? <Loader2 size={12} className="spin" /> : null} Save
        </button>
      </span>
    </div>
  );
}

function UserRow({
  row,
  self,
  lastAdmin,
  busy,
  onRole,
  onReset,
  onDelete,
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
    <div className="user-row">
      <span className="user-row__name">
        {row.username}
        {self && <span className="badge">you</span>}
      </span>
      <select
        className="select"
        value={row.role}
        aria-label={`Role for ${row.username}`}
        disabled={busy || lastAdmin}
        onChange={(event) => void onRole(event.target.value)}
      >
        <option value="admin">admin</option>
        <option value="user">user</option>
      </select>
      <span className="faint">{formatDate(row.createdAt)}</span>
      <span className="cell-actions">
        {resetting ? (
          <>
            <input
              className="input"
              style={{ width: 150 }}
              value={password}
              autoFocus
              placeholder="new password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setResetting(false);
                if (event.key === "Enter" && password.length >= 6) {
                  void onReset(password).then((ok) => {
                    if (ok) {
                      setResetting(false);
                      setPassword("");
                    }
                  });
                }
              }}
            />
            <button
              className="btn btn--sm"
              disabled={password.length < 6 || busy}
              onClick={() =>
                void onReset(password).then((ok) => {
                  if (ok) {
                    setResetting(false);
                    setPassword("");
                  }
                })
              }
            >
              <KeyRound size={12} /> Set
            </button>
          </>
        ) : (
          <button
            className="icon-btn"
            title={`Reset password for ${row.username}`}
            aria-label={`Reset password for ${row.username}`}
            onClick={() => setResetting(true)}
          >
            <KeyRound size={13} />
          </button>
        )}
        {!self && (
          <ConfirmButton label={`Delete ${row.username}`} onConfirm={() => void onDelete()}>
            <Trash2 size={13} />
          </ConfirmButton>
        )}
      </span>
    </div>
  );
}
