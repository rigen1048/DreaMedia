"""Root .env loader (owner decision: .env lives at the REPO ROOT).

The app runs from Backend/, so we walk up to the repo root and load
KEY=VALUE lines into os.environ without overriding real env vars.
No dependency — the format we emit in .env.example is all we parse.
"""
from __future__ import annotations

import os
from pathlib import Path


def load_root_env() -> None:
    root = Path(__file__).resolve().parents[2]  # Backend/Utility/ → Backend/ → repo root
    env_file = root / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_root_env()
