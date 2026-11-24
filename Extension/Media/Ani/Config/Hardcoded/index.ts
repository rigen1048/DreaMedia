/**
 * DreaMedia Extension — Anime Hardcoded Configuration
 * Constants that never change between deployments. No `any` type permitted.
 */

export const ANIME_IMPORT_HOSTS: ReadonlySet<string> = new Set([]);

export const DEFAULT_BACKEND = "http://127.0.0.1:8123";

export const ANCHOR_MAX_ATTEMPTS = 6;
export const ANCHOR_INITIAL_DELAY_MS = 500;
export const ANCHOR_RETRY_INTERVAL_MS = 5000;
export const ANCHOR_RETRY_DELAY_MS = 1500;

export const LIVE_INTERVAL_MS = 5000;
export const TRACKING_REFRESH_INTERVAL_MS = 1000;
