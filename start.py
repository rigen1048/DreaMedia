#!/usr/bin/env python3
"""DreaMedia launcher (D52) — replaces start.sh.

Default run : backup → full wipe → clean rebuild → AUTO-RESTORE latest dump
--fresh     : backup only, no restore (clean slate, safety dump kept)

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


def restore_latest(backup_dir: Path, env) -> bool:
    dumps = sorted(backup_dir.glob("dreamedia-*.dump"), key=lambda p: p.stat().st_mtime, reverse=True)
    latest = None
    for candidate in dumps:
        check = subprocess.run(["docker", "compose", "exec", "-T", "db", "pg_restore", "-l"],
                               cwd=ROOT, input=candidate.read_bytes(), capture_output=True, env=env)
        if check.returncode == 0:
            latest = candidate
            break
        print(f"  ⚠ skipping invalid dump: {candidate.name}")
    if latest is None:
        if dumps:
            sys.exit("✗ All dumps are invalid. NOT starting against an empty database.")
        print("→ No dump to restore; starting empty.")
        return False
    print(f"→ Auto-restoring {latest.name} (D52)...")
    with latest.open("rb") as fh:
        result = subprocess.run(
            ["docker", "compose", "exec", "-T", "db", "pg_restore",
             "-U", "dreamedia", "-d", "dreamedia", "--clean", "--if-exists"],
            cwd=ROOT, stdin=fh, stderr=subprocess.PIPE, env=env,
        )
    if result.returncode != 0:
        # A failed restore can leave the db empty or partial — do NOT start.
        sys.exit(
            "RESTORE FAILED: " + result.stderr.decode()[-300:] + "\n"
            "  Not starting against an empty/partial database. Fix and rerun."
        )
    print("  ✓ restore complete")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="DreaMedia launcher (D52)")
    parser.add_argument("--fresh", action="store_true", help="backup only, no restore (clean slate)")
    parser.add_argument("--dev", action="store_true",
                        help="dev mode: local uvicorn + bun dev in the foreground "
                             "(default: full docker stack — db, backend, frontend)")
    args = parser.parse_args()

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
    print("🐴 DreaMedia is starting...")
    print(f"   On this machine : http://localhost:3000")
    if access == "wifi":
        print(f"   From your WiFi  : http://{ip}:3000")
    else:
        print("   Access mode     : computer (localhost only, D54)")
    print(f"   GraphQL         : http://localhost:8000/graphql")
    print("=" * 50)

    if not shutil.which("docker"):
        sys.exit("✗ Missing 'docker' — install it and rerun.")
    if args.dev:
        for tool in ("uv", "bun", "node"):
            if not shutil.which(tool):
                sys.exit(f"✗ Missing '{tool}' (needed for --dev) — install it and rerun.")

    backup_dir = Path(env.get("BACKUP_DIR", str(ROOT / "backups")))
    keep = int(env.get("BACKUP_KEEP_LATEST", "5"))

    # 1. backup (refuse to wipe without one, unless there is no db at all)
    backup(backup_dir, keep, env)

    # 2. full teardown
    print("→ Full teardown: containers, volumes, builder cache...")
    run(["docker", "compose", "down", "-v", "--remove-orphans"], cwd=ROOT, check=False)
    run(["docker", "builder", "prune", "--all", "--force"], check=False, quiet=True)

    # 3. fresh db
    print("→ Starting fresh Postgres...")
    run(["docker", "compose", "up", "-d", "db"], cwd=ROOT)
    for _ in range(30):
        if db_running(env):
            break
        time.sleep(1)

    # 4. restore (unless --fresh)
    restored = False
    if args.fresh:
        print("→ --fresh: skipping restore. Clean slate; your dump is safe in backups/.")
    else:
        restored = restore_latest(backup_dir, env)

    # 5. app services
    if not args.dev:
        # Default: the whole app runs in containers (D6 docker app).
        print("→ Building + starting the stack (db, bridge, backend, frontend)...")
        result = subprocess.run(
            ["docker", "compose", "up", "-d", "--build"],
            cwd=ROOT, capture_output=True, text=True, env=env,
        )
        if result.returncode != 0:
            print(result.stdout[-1500:])
            print(result.stderr[-2500:])
            compose_ps(env)
            sys.exit("✗ docker compose up failed (details above)")

        print("→ Waiting for the app to answer on :3000...")
        if not wait_for("http://127.0.0.1:3000/health", seconds=180):
            compose_ps(env)
            compose_logs(env)
            sys.exit("✗ The stack started but never became healthy (see logs above)")

        bridge_ok = wait_for("http://127.0.0.1:3100/health", seconds=30)
        if not restored:
            print("→ Empty database: open the app and use 'Sign up' to create your account.")
        print()
        print("=" * 50)
        print(f"🐴 DreaMedia is up: http://localhost:3000"
              + (f"  (LAN: http://{lan_ip()}:3000)" if bind == "0.0.0.0" else ""))
        print(f"   bell bridge    : http://127.0.0.1:3100/health "
              + ("✓" if bridge_ok else "✗ not answering"))
        print("   logs   : docker compose logs -f")
        print("   stop   : docker compose down")
        print("=" * 50)
        return

    # --dev: local processes instead of containers
    # The frontend owns the notification receiver; the backend pushes into it.
    env.setdefault("FRONTEND_NOTIFY_URL", "http://127.0.0.1:3100/api/notifications")
    bridge_env = dict(env)
    bridge_env.setdefault("BRIDGE_PORT", "3100")
    bridge_env.setdefault("BRIDGE_STORE", str(FRONTEND / ".bridge" / "inbox.json"))
    print("→ Starting notification bridge on :3100...")
    bridge_log = (ROOT / ".bridge.log").open("w")
    bridge = subprocess.Popen(
        ["node", "server/notify-bridge.mjs"],
        cwd=FRONTEND, stdout=bridge_log, stderr=subprocess.STDOUT, env=bridge_env,
    )
    (ROOT / ".bridge.pid").write_text(str(bridge.pid))

    print("→ Syncing backend deps (uv)...")
    run(["uv", "sync", "-q"], cwd=BACKEND)
    print(f"→ Starting backend on {bind}:8000...")
    backend_log = BACKEND_LOG.open("w")
    backend = subprocess.Popen(
        ["uv", "run", "uvicorn", "App.main:app", "--host", bind, "--port", "8000"],
        cwd=BACKEND, stdout=backend_log, stderr=subprocess.STDOUT, env=env,
    )
    (ROOT / ".backend.pid").write_text(str(backend.pid))

    def cleanup(*_):
        print("\n→ Stopping backend + bridge...")
        bridge.terminate()
        try:
            bridge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge.kill()
        (ROOT / ".bridge.pid").unlink(missing_ok=True)
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
    print("→ Starting frontend on :3000...")
    time.sleep(2)
    try:
        subprocess.run(["bun", "run", "dev"], cwd=FRONTEND, env=env)
    except KeyboardInterrupt:
        pass
    cleanup()


if __name__ == "__main__":
    main()
