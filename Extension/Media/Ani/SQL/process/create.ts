/**
 * DreaMedia Extension — Anime SQL Process Create
 * Creating all the storage/schema required for anime media.
 * No `any` type permitted.
 */

import type { DomainRow } from "../../Config/Model/types";
import type { ImportJob } from "../../Config/Model/types";

export const ANI_STORAGE_KEYS = {
  DOMAINS: "domains",
  BLOCKED_ANI: "blockedAni",
} as const;

export async function createAnimeStorage(): Promise<void> {
  const defaults: Record<string, unknown> = {
    [ANI_STORAGE_KEYS.DOMAINS]: [],
    [ANI_STORAGE_KEYS.BLOCKED_ANI]: [],
  };

  const existing = await chrome.storage.local.get(Object.keys(defaults));
  const missing: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in existing) || existing[key] === undefined) {
      missing[key] = value;
    }
  }

  if (Object.keys(missing).length > 0) {
    await chrome.storage.local.set(missing);
  }
}

export function isValidDomainRow(row: unknown): row is DomainRow {
  if (row === null || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "number" &&
    typeof r.domain === "string" &&
    (r.media === "yt" || r.media === "ani") &&
    typeof r.enabled === "boolean"
  );
}

export function isValidImportJob(job: unknown): job is ImportJob {
  if (job === null || typeof job !== "object") return false;
  const r = job as Record<string, unknown>;
  return (
    typeof r.jobId === "string" &&
    typeof r.status === "string" &&
    typeof r.requested === "number" &&
    typeof r.processed === "number" &&
    typeof r.resolved === "number" &&
    typeof r.added === "number" &&
    typeof r.skipped === "number" &&
    typeof r.failed === "number" &&
    Array.isArray(r.errors)
  );
}
