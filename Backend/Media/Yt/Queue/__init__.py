"""Unified YouTube import queue (D62).

All source ingestion — extension .json import, CSV import, backup restore,
fetch-all — writes to the same durable queue table. Eight per-user workers
poll their section, claim one item, feed it to the manager, sleep 1 second,
repeat → 8 req/s per user, no worker overlap.

Backend stays fully non-blocking async; only the worker/polling side is
rate-limited.
"""
