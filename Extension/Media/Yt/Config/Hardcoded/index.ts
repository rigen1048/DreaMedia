/**
 * DreaMedia Extension — YouTube Hardcoded Configuration
 * Constants that never change between deployments. No `any` type permitted.
 */

export const YOUTUBE_IMPORT_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
]);

export const YOUTUBE_CHANNEL_PATH = /^\/(@[^/]+|channel\/UC[A-Za-z0-9_-]{22})(\/|$)/i;

export const YOUTUBE_SELECTORS = "ytd-channel-renderer, ytd-grid-channel-renderer";

export const YOUTUBE_SUBSCRIPTIONS_PATH = "/feed/channels";

export const DEFAULT_BACKEND = "http://127.0.0.1:8123";

export const WS_HANDSHAKE_TIMEOUT_MS = 15000;
export const WS_PONG_TIMEOUT_MS = 10000;
export const WS_OPERATION_TIMEOUT_MS = 120000;
export const WS_RETRY_BASE_MS = 1000;
export const WS_RETRY_MAX_MS = 30000;
export const WS_KEEPALIVE_INTERVAL_MS = 20000;
export const CONNECTION_FAILURE_GRACE_MS = 30000;

export const SCAN_SLEEP_MS = 800;
export const SCAN_MAX_ROUNDS = 100;
export const SCAN_STABLE_ROUNDS = 3;

export const IMPORT_POLL_INTERVAL_MS = 1200;
export const IMPORT_ERROR_RETRY_INTERVAL_MS = 2000;
export const RECENT_JOB_LIMIT = 10;

export const ANCHOR_MAX_ATTEMPTS = 6;
export const ANCHOR_INITIAL_DELAY_MS = 500;
export const ANCHOR_RETRY_INTERVAL_MS = 5000;
export const ANCHOR_RETRY_DELAY_MS = 1500;

export const LIVE_INTERVAL_MS = 5000;
export const TRACKING_REFRESH_INTERVAL_MS = 1000;
export const BLOCKED_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const BLOCKED_CHECK_INTERVAL_MS = 1000;

export const DOMAINS_ALARM_PERIOD_MINUTES = 5;
export const WS_WATCHDOG_ALARM_PERIOD_MINUTES = 1;
