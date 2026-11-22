#!/usr/bin/env python3
"""DreaMedia launcher (D52) — replaces start.sh.

Default run : backup → full wipe → clean rebuild → empty database
`update`     : verified backup → fast-forward-only Git pull → restore → rebuild
The default command leaves restore manual: Admin → Restore → upload a dump.
No command pushes Git changes or restores data without an explicit request.

Ctrl+C stops the backend + frontend; Postgres stays up (docker compose down).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "Backend"
FRONTEND = ROOT / "Frontend"
EXTENSION = ROOT / "Extension"
SHARED = EXTENSION / "shared"
STATE = ROOT / ".last-pgpass-sha"
BACKEND_LOG = ROOT / ".backend.log"


def load_env() -> dict[str, str]:
    env = dict(os.environ)
    env_file = ROOT / ".env"
    if not env_file.is_file():
        sys.exit("✗ No .env at the repo root. Fix: cp .env.example .env → set DREAMEDIA_PG_PASSWORD")
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            env.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    if not env.get("DREAMEDIA_PG_PASSWORD"):
        sys.exit("✗ DREAMEDIA_PG_PASSWORD is empty in .env (required, see .env.example)")
    return env


def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True, quiet: bool = False) -> subprocess.CompletedProcess:
    if not quiet:
        print(f"  $ {' '.join(cmd)}")
    # env=None inherits this process' environment, which includes the
    # ACCESS_HOST exported in main() — compose needs it to bind ports.
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"✗ failed: {' '.join(cmd)}\n{result.stderr[-600:]}")
    return result


def compose_ps(env) -> None:
    """Print the stack state — used when something refuses to come up."""
    result = subprocess.run(
        ["docker", "compose", "ps", "-a"], cwd=ROOT, capture_output=True, text=True, env=env,
    )
    print(result.stdout.strip() or "  (no containers)")


def compose_logs(env, tail: int = 25) -> None:
    result = subprocess.run(
        ["docker", "compose", "logs", "--no-color", "--tail", str(tail)],
        cwd=ROOT, capture_output=True, text=True, env=env,
    )
    if result.stdout.strip():
        print(result.stdout.strip()[-4000:])


def wait_for(url: str, seconds: int = 120) -> bool:
    """Block until the URL answers 2xx/3xx — no fixed sleeps on startup."""
    import urllib.error
    import urllib.request

    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if 200 <= response.status < 400:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(1.5)
    return False


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def build_extensions() -> None:
    """Build the browser extension for both Chrome (mv3) and Firefox (mv2).

    `shared/` is the single source of truth; this copies it over both variants
    so `python3 setup.py` produces a loadable mv2 and mv3 extension (the
    variant-specific manifest.json already lives in each variant dir).
    """
    if not SHARED.is_dir():
        print("✗ Extension shared/ missing — skipping extension build")
        return
    for variant in ("mv2", "mv3"):
        target = EXTENSION / variant
        target.mkdir(parents=True, exist_ok=True)
        shared_names = {src.name for src in SHARED.iterdir()}
        variant_only = {"manifest.json"}
        if "icons" not in shared_names:
            variant_only.add("icons")
        for existing in target.iterdir():
            if existing.name in variant_only:
                continue
            if existing.is_dir():
                shutil.rmtree(existing)
            else:
                existing.unlink()
        for src in sorted(SHARED.iterdir()):
            if src.is_file():
                shutil.copy2(src, target / src.name)
            elif src.is_dir():
                shutil.copytree(src, target / src.name, dirs_exist_ok=True)
        print(f"→ extension built: {variant}/ ({len(list(target.iterdir()))} entries)")


def db_running(env) -> bool:
    result = subprocess.run(
        ["docker", "compose", "exec", "-T", "db", "pg_isready", "-U", "dreamedia"],
        cwd=ROOT, capture_output=True, env=env,
    )
    return result.returncode == 0


def pgdata_volume_exists() -> bool:
    """A named pgdata volume = a PREVIOUS install with data. A stopped db is
    NOT a first run — tearing it down would destroy data (critical review)."""
    result = subprocess.run(
        ["docker", "volume", "ls", "--format", "{{.Name}}"],
        capture_output=True, text=True,
    )
    return any(name.endswith("_pgdata") for name in result.stdout.split())


def backup(backup_dir: Path, keep: int, env) -> Path | None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    if not db_running(env):
        if not pgdata_volume_exists():
            print("→ No pgdata volume: genuine first run, nothing to back up.")
            return None
        # Stopped but populated: bring it up and back up — never assume empty.
        print("→ Database is stopped but a pgdata volume exists — starting it to back up...")
        run(["docker", "compose", "up", "-d", "db"], cwd=ROOT)
        for _ in range(30):
            if db_running(env):
                break
            time.sleep(1)
        if not db_running(env):
            sys.exit("✗ Cannot start the existing database for backup. "
                     "Refusing to tear down data I cannot back up.")
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1e6) % 10**6:06d}"
    out = backup_dir / f"dreamedia-{stamp}.dump"
    print(f"→ Backing up Postgres → {out}")
    with out.open("wb") as fh:
        result = subprocess.run(
            ["docker", "compose", "exec", "-T", "db", "pg_dump", "-U", "dreamedia", "-Fc", "dreamedia"],
            cwd=ROOT, stdout=fh, stderr=subprocess.PIPE, env=env,
        )
    if result.returncode != 0 or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        print(f"  ✗ BACKUP FAILED: {result.stderr.decode()[-300:]}")
        sys.exit("  Refusing to wipe without a working backup. Fix the backup, then rerun.")
    # Validate the dump is a real archive before it becomes our only lifeline.
    check = subprocess.run(["docker", "compose", "exec", "-T", "db", "pg_restore", "-l"],
                           cwd=ROOT, input=out.read_bytes(), capture_output=True, env=env)
    if check.returncode != 0:
        out.unlink(missing_ok=True)
        sys.exit(f"✗ Backup file failed validation (pg_restore -l). Refusing to wipe.")
    print("  ✓ backup ok")
    keep = max(keep, 2)  # hardcoded floor (D2)
    dumps = sorted(backup_dir.glob("dreamedia-*.dump"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in dumps[keep:]:
        old.unlink()
    return out


def require_clean_git_worktree() -> None:
    result = run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=ROOT, check=False,
    )
    if result.returncode != 0:
        sys.exit("✗ 'update' requires this directory to be a Git checkout.")
    if result.stdout.strip():
        sys.exit(
            "✗ 'update' requires a clean Git worktree. Commit or stash local changes, "
            "then retry; no changes were pulled."
        )


def pull_git_changes() -> None:
    """Fast-forward only: never rebase, reset, or overwrite local commits."""
    result = run(["git", "pull", "--ff-only"], cwd=ROOT, check=False)
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.stderr.strip():
        print(result.stderr.rstrip(), file=sys.stderr)
    if result.returncode != 0:
        sys.exit(
            "✗ git pull --ff-only failed. The local branch was not rewritten; "
            "resolve the Git state and retry."
        )


def running_compose_services(env) -> set[str]:
    result = subprocess.run(
        ["docker", "compose", "ps", "--status", "running", "--services"],
        cwd=ROOT, capture_output=True, text=True, env=env,
    )
    if result.returncode != 0:
        sys.exit(f"✗ Could not inspect Docker Compose services: {result.stderr[-1000:]}")
    return set(result.stdout.split())


def restore_database_backup(dump: Path, env) -> None:
    """Restore a previously validated custom-format dump from the host file."""
    command = [
        "docker", "compose", "exec", "-T", "db", "pg_restore",
        "-U", "dreamedia", "-d", "dreamedia",
        "--clean", "--if-exists", "--exit-on-error",
        "--no-owner", "--no-privileges",
    ]
    print(f"→ Restoring verified Postgres backup: {dump}")
    try:
        source = dump.open("rb")
    except OSError as exc:
        sys.exit(f"✗ Could not read backup {dump}: {exc}")
    try:
        with source:
            result = subprocess.run(
                command, cwd=ROOT, stdin=source, capture_output=True, env=env,
            )
    except OSError as exc:
        sys.exit(
            f"✗ Could not start the Docker restore command: {exc}. "
            f"The verified backup remains at {dump}."
        )
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace")[-2000:].strip()
        sys.exit(
            "✗ Automatic restore failed. The PostgreSQL volume was kept and app "
            f"services remain stopped. The verified backup is still at {dump}.\n{detail}"
        )
    print("  ✓ pre-update backup restored")


def update_database(backup_dir: Path, keep: int, env) -> Path | None:
    """Pull code and restore a validated snapshot without deleting pgdata."""
    require_clean_git_worktree()
    running = running_compose_services(env)
    app_services = [name for name in ("backend", "frontend") if name in running]
    database_restarted = False
    try:
        if app_services:
            print("→ Stopping app services for a consistent backup...")
            run(["docker", "compose", "stop", *app_services], cwd=ROOT)

        dump = backup(backup_dir, keep, env)
        pull_git_changes()
        build_extensions()

        print("→ Stopping the stack while preserving the PostgreSQL volume...")
        run(["docker", "compose", "down", "--remove-orphans"], cwd=ROOT)
        database_restarted = True
        print("→ Starting PostgreSQL...")
        run(["docker", "compose", "up", "-d", "db"], cwd=ROOT)
        for _ in range(30):
            if db_running(env):
                break
            time.sleep(1)
        if not db_running(env):
            sys.exit(
                "✗ PostgreSQL did not become ready. The pgdata volume was preserved; "
                f"backup: {dump or '(no prior database)'}"
            )

        if dump is not None:
            restore_database_backup(dump, env)
        else:
            print("→ No existing database data; skipping restore on first run.")
        return dump
    except BaseException:
        if not database_restarted and app_services:
            print("→ Update stopped before database restart; restarting prior app services...")
            run(["docker", "compose", "start", *app_services], cwd=ROOT, check=False)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="DreaMedia launcher (D52)")
    parser.add_argument("command", nargs="?", choices=("update",),
                        help="pull Git changes and restore a verified pre-update database backup")
    parser.add_argument("--dev", action="store_true",
                        help="dev mode: local uvicorn + bun dev in the foreground "
                             "(default: full docker stack — db, backend, frontend)")
    parser.add_argument("--build-extensions-only", action="store_true",
                        help="synchronize Extension/shared into the mv2 and mv3 packages, then exit")
    args = parser.parse_args()

    updating = args.command == "update"
    if args.build_extensions_only and updating:
        parser.error("'update' cannot be combined with --build-extensions-only")
    if updating and args.dev:
        parser.error("'update' is Docker-mode only; stop local --dev services and update them manually")

    if args.build_extensions_only:
        build_extensions()
        return

    if not updating:
        build_extensions()
    env = load_env()
    access = env.get("ACCESS", "computer").lower()
    if access not in ("wifi", "computer"):
        sys.exit("✗ ACCESS must be 'wifi' or 'computer' (see .env.example)")
    bind = "0.0.0.0" if access == "wifi" else "127.0.0.1"
    # compose publish binding (D54). Export it for real: child processes only
    # see os.environ, not our parsed copy.
    os.environ.setdefault("ACCESS_HOST", bind)
    env.setdefault("ACCESS_HOST", bind)
    # Containers run as us, so backups land on the host with our ownership.
    os.environ.setdefault("DREAMEDIA_UID", str(os.getuid()))
    os.environ.setdefault("DREAMEDIA_GID", str(os.getgid()))

    # Password stability: warning only (never enforcement).
    pass_sha = hashlib.sha256(env["DREAMEDIA_PG_PASSWORD"].encode()).hexdigest()
    if STATE.is_file() and STATE.read_text().strip() != pass_sha:
        print("⚠ WARNING: DREAMEDIA_PG_PASSWORD changed since the last run.")
        print("  Fresh volume will use it fine; we recommend keeping it stable. 5s...")
        time.sleep(5)
    STATE.write_text(pass_sha)

    ip = lan_ip()
    print("=" * 50)
    print("🐴 DreaMedia is updating..." if updating else "🐴 DreaMedia is starting...")
    print(f"   On this machine : http://localhost:8124")
    if access == "wifi":
        print(f"   From your WiFi  : http://{ip}:8124")
    else:
        print("   Access mode     : computer (localhost only, D54)")
    print(f"   GraphQL         : http://localhost:8123/graphql")
    print("=" * 50)

    if not shutil.which("docker"):
        sys.exit("✗ Missing 'docker' — install it and rerun.")
    if args.dev:
        for tool in ("uv", "bun", "node"):
            if not shutil.which(tool):
                sys.exit(f"✗ Missing '{tool}' (needed for --dev) — install it and rerun.")

    backup_dir = Path(env.get("BACKUP_DIR", str(ROOT / "backups")))
    keep = int(env.get("BACKUP_KEEP_LATEST", "5"))

    restored_backup = None
    if updating:
        restored_backup = update_database(backup_dir, keep, env)
    else:
        # Default setup behavior is intentionally unchanged: backup, wipe the
        # volumes, and leave restoration to the Admin UI.
        backup(backup_dir, keep, env)

        print("→ Full teardown: containers, volumes, builder cache...")
        run(["docker", "compose", "down", "-v", "--remove-orphans"], cwd=ROOT, check=False)
        run(["docker", "builder", "prune", "--all", "--force"], check=False, quiet=True)

        print("→ Starting fresh Postgres...")
        run(["docker", "compose", "up", "-d", "db"], cwd=ROOT)
        for _ in range(30):
            if db_running(env):
                break
            time.sleep(1)

        # Loading data back remains a manual action for the default command.
        print("→ Empty database. Your safety dump stays in "
              f"{backup_dir}; restore it from Admin → Restore when you want it.")

    # 5. app services
    if not args.dev:
        # Default: the whole app runs in containers (D6 docker app).
        print("→ Building + starting the stack (db, backend, frontend)...")
        result = subprocess.run(
            ["docker", "compose", "up", "-d", "--build"],
            cwd=ROOT, capture_output=True, text=True, env=env,
        )
        if result.returncode != 0:
            print(result.stdout[-1500:])
            print(result.stderr[-2500:])
            compose_ps(env)
            sys.exit("✗ docker compose up failed (details above)")

        print("→ Waiting for the app to answer on :8124...")
        if not wait_for("http://127.0.0.1:8124/health", seconds=180):
            compose_ps(env)
            compose_logs(env)
            sys.exit("✗ The stack started but never became healthy (see logs above)")

        if updating and restored_backup is not None:
            print(f"→ Pre-update backup restored: {restored_backup}")
        elif updating:
            print("→ No previous database existed; first-run database initialized.")
        else:
            print("→ Empty database: open the app, sign up, then Admin → Restore if you")
            print("  want an old dump back (it is never loaded automatically).")
        print()
        print("=" * 50)
        print(f"🐴 DreaMedia is up: http://localhost:8124"
              + (f"  (LAN: http://{lan_ip()}:8124)" if bind == "0.0.0.0" else ""))
        print("   notification history: PostgreSQL")
        print("   logs   : docker compose logs -f")
        print("   stop   : docker compose down")
        print("=" * 50)
        return

    # --dev: local processes instead of containers; notifications still live in PostgreSQL.
    print("→ Syncing backend deps (uv)...")
    run(["uv", "sync", "-q"], cwd=BACKEND)
    print(f"→ Starting backend on {bind}:8123...")
    backend_log = BACKEND_LOG.open("w")
    backend = subprocess.Popen(
        ["uv", "run", "uvicorn", "App.main:app", "--host", bind, "--port", "8123"],
        cwd=BACKEND, stdout=backend_log, stderr=subprocess.STDOUT, env=env,
    )
    (ROOT / ".backend.pid").write_text(str(backend.pid))

    def cleanup(*_):
        print("\n→ Stopping backend + frontend...")
        backend.terminate()
        try:
            backend.wait(timeout=5)
        except subprocess.TimeoutExpired:
            backend.kill()
        (ROOT / ".backend.pid").unlink(missing_ok=True)
        print(f"→ Postgres left running (docker compose down to stop). Backups in {backup_dir}.")
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    # 6. frontend
    print("→ Installing frontend deps (bun)...")
    run(["bun", "install", "--silent"], cwd=FRONTEND)
    print("→ Starting frontend on :8124...")
    time.sleep(2)
    try:
        subprocess.run(["bun", "run", "dev"], cwd=FRONTEND, env=env)
    except KeyboardInterrupt:
        pass
    cleanup()


if __name__ == "__main__":
    main()
