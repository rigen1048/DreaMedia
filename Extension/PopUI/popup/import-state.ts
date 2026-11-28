/**
 * YouTube import state management — scan results, job tracking, polling,
 * history persistence, and the import table UI.
 * No `any` type permitted.
 */

import { $, send, status, IMPORT_TAB_KEY, SCAN_TAB_KEY } from "./shared";
import type { SubscriptionOptions } from "../../Media/Yt/Config/Model/types";

// ── State ────────────────────────────────────────────────────────────

let scannedSubscriptions: { url: string; name: string }[] = [];
let subscriptionScanComplete = false;
const activeImportJobs = new Map<string, { message: string }>();
const failedImportJobs = new Set<string>();
const recentImportJobIds = new Set<string>();
const terminalImportJobIds = new Set<string>();
const deletingImportJobIds = new Set<string>();
const pollingImportJobs = new Set<string>();
const hiddenImportJobIds = new Set<string>();
const importHistoryWriteFailures = new Set<string>();
const FINISHED_IMPORT_STATUSES = new Set(["completed", "partial"]);
let importJobsStorageWrite = Promise.resolve();
let scanStatusMessage = "";
let scanStatusClass = "";
let lastImportStatus = "";
let lastImportStatusClass = "";

// ── Getters (read-only access for other modules) ─────────────────────

export function getScannedSubscriptions(): { url: string; name: string }[] {
  return scannedSubscriptions;
}

export function setScannedSubscriptions(
  channels: { url: string; name: string }[]
): void {
  scannedSubscriptions = channels;
}

export function getSubscriptionScanComplete(): boolean {
  return subscriptionScanComplete;
}

export function setSubscriptionScanComplete(complete: boolean): void {
  subscriptionScanComplete = complete;
}

export function getActiveImportJobCount(): number {
  return activeImportJobs.size;
}

export function getFailedImportJobCount(): number {
  return failedImportJobs.size;
}

export function getRecentImportJobCount(): number {
  return recentImportJobIds.size;
}

// ── Status rendering ─────────────────────────────────────────────────

export function setAddSourceLabel(text: string): void {
  $("subscribeLabel").textContent = text;
}

export function renderImportStatus(): void {
  const jobs = Array.from(activeImportJobs.values());
  const lastJob = jobs[jobs.length - 1];
  const jobMessage = jobs.length
    ? `${jobs.length > 1 ? `${jobs.length} backend batches active. ` : ""}${
        lastJob?.message ?? ""
      }`
    : lastImportStatus;
  const historyWarning = importHistoryWriteFailures.size
    ? `History could not be saved for ${importHistoryWriteFailures.size} batch${importHistoryWriteFailures.size === 1 ? "" : "es"}; keep this popup open until it is saved.`
    : "";
  const messages = [scanStatusMessage, jobMessage, historyWarning].filter(Boolean);
  const cls = scanStatusMessage
    ? scanStatusClass
    : importHistoryWriteFailures.size
      ? "err"
      : jobs.length
      ? "ok"
      : lastImportStatusClass;
  status("importStatus", messages.join(" · "), cls);
  const tableButton = $("openImportTable");
  tableButton.hidden =
    !activeImportJobs.size && !failedImportJobs.size && !recentImportJobIds.size;
  $("importTableRow").hidden = tableButton.hidden;
  const deleteButton = $("deleteImportTable") as HTMLButtonElement;
  const finishedJobs = [...recentImportJobIds].filter((jobId) => terminalImportJobIds.has(jobId));
  deleteButton.hidden = tableButton.hidden;
  const deleting = finishedJobs.some((jobId) => deletingImportJobIds.has(jobId));
  deleteButton.disabled = finishedJobs.length === 0 || deleting;
  deleteButton.title = deleting
    ? "Removing finished import history…"
    : finishedJobs.length
    ? `Delete ${finishedJobs.length} finished batch${finishedJobs.length === 1 ? "" : "es"}; imported sources remain`
    : "Available after an import batch finishes";
  $("importTableMeta").textContent = activeImportJobs.size
    ? `${activeImportJobs.size} active`
    : failedImportJobs.size
      ? `${failedImportJobs.size} with failures`
      : "Recent batches";
}

export function setImportScanStatus(text: string, cls = ""): void {
  scanStatusMessage = text;
  scanStatusClass = cls;
  renderImportStatus();
}

export function setImportJobStatus(text: string, cls = ""): void {
  lastImportStatus = text;
  lastImportStatusClass = cls;
  renderImportStatus();
}

// ── History persistence ──────────────────────────────────────────────

export async function persistImportJobId(jobId: string, promoteRecent = false): Promise<void> {
  importJobsStorageWrite = importJobsStorageWrite
    .catch(() => {})
    .then(async () => {
      if (hiddenImportJobIds.has(jobId)) return;
      let lastError = "No response from the extension background worker";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await send("dreamedia:updateYoutubeImportHistory", {
            jobId,
            active: activeImportJobs.has(jobId),
            failed: failedImportJobs.has(jobId),
            recent: promoteRecent,
          });
          if (response.ok) {
            importHistoryWriteFailures.delete(jobId);
            if (response.data === false) {
              hiddenImportJobIds.add(jobId);
              forgetImportJob(jobId);
            }
            renderImportStatus();
            return;
          }
          lastError = response.error ?? lastError;
        } catch (error) {
          lastError = error instanceof Error ? error.message : lastError;
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      console.warn(`Could not persist import history for ${jobId}: ${lastError}`);
      importHistoryWriteFailures.add(jobId);
      renderImportStatus();
    });
  await importJobsStorageWrite;
}

export async function isImportJobHidden(jobId: string): Promise<boolean> {
  const stored = await chrome.storage.local.get("youtubeHiddenImportJobIds");
  const hidden = Array.isArray(stored.youtubeHiddenImportJobIds)
    ? (stored.youtubeHiddenImportJobIds as string[])
    : [];
  hidden.forEach((id) => hiddenImportJobIds.add(id));
  return hiddenImportJobIds.has(jobId);
}

function forgetImportJob(jobId: string): void {
  activeImportJobs.delete(jobId);
  failedImportJobs.delete(jobId);
  recentImportJobIds.delete(jobId);
  terminalImportJobIds.delete(jobId);
  importHistoryWriteFailures.delete(jobId);
}

export function isFullySuccessfulImport(job: {
  status: string;
  requested: number;
  processed: number;
  added: number;
  skipped: number;
  failed: number;
  errors?: string[];
}): boolean {
  const requested = Math.max(0, Number(job.requested) || 0);
  return job.status === "completed" &&
    Number(job.failed) === 0 &&
    Number(job.processed) >= requested &&
    Number(job.added) + Number(job.skipped) >= requested &&
    (job.errors?.length ?? 0) === 0;
}

export async function deleteImportJobHistory(jobId: string): Promise<boolean> {
  if (activeImportJobs.has(jobId) || deletingImportJobIds.has(jobId)) return false;
  deletingImportJobIds.add(jobId);
  try {
    const backendResponse = await send("dreamedia:deleteYoutubeImport", { jobId });
    if (!backendResponse.ok || backendResponse.data !== true) {
      setImportJobStatus(
        `Could not delete finished batch ${jobId.slice(0, 8)}: ${backendResponse.error ?? "backend rejected the deletion"}.`,
        "err",
      );
      return false;
    }
    const historyResponse = await send("dreamedia:hideYoutubeImportHistory", { jobId });
    if (!historyResponse.ok || historyResponse.data !== true) {
      setImportJobStatus(
        `Batch ${jobId.slice(0, 8)} was deleted on the backend, but its popup history could not be cleared.`,
        "err",
      );
      return false;
    }
    hiddenImportJobIds.add(jobId);
    forgetImportJob(jobId);
    renderImportStatus();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    setImportJobStatus(`Could not clear batch ${jobId.slice(0, 8)}: ${message}.`, "err");
    return false;
  } finally {
    deletingImportJobIds.delete(jobId);
    renderImportStatus();
  }
}

export async function deleteFinishedImportsFromPopup(): Promise<void> {
  const jobIds = [...recentImportJobIds].filter((jobId) => terminalImportJobIds.has(jobId));
  if (!jobIds.length) return;
  const batchWord = jobIds.length === 1 ? "finished batch" : `${jobIds.length} finished batches`;
  if (!window.confirm(`Delete ${batchWord} and clear the import table history? Sources already added to DreaMedia will remain.`)) return;
  let deleted = 0;
  let failed = 0;
  for (const jobId of jobIds) {
    if (await deleteImportJobHistory(jobId)) deleted += 1;
    else failed += 1;
  }
  if (deleted > 0 && failed === 0) {
    setImportJobStatus(
      `${deleted} finished import batch${deleted === 1 ? "" : "es"} removed from the popup and extension history. Existing sources remain.`,
      "ok",
    );
  } else if (deleted > 0) {
    setImportJobStatus(
      `${deleted} finished batch${deleted === 1 ? "" : "es"} removed; ${failed} could not be cleared. Existing sources remain.`,
      "err",
    );
  }
}

// ── Storage listeners ────────────────────────────────────────────────

export function listenImportHistoryChanges(): void {
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.youtubeHiddenImportJobIds) return;
    const hidden = changes.youtubeHiddenImportJobIds.newValue;
    if (!Array.isArray(hidden)) return;
    for (const jobId of hidden) {
      if (typeof jobId !== "string") continue;
      hiddenImportJobIds.add(jobId);
      forgetImportJob(jobId);
    }
    renderImportStatus();
  });

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.youtubeScanChannels) return;
    const savedChannels = changes.youtubeScanChannels.newValue;
    const scanButton = $("openScanTable");
    const count = Array.isArray(savedChannels) ? savedChannels.length : 0;
    scanButton.hidden = count === 0;
    $("scanTableMeta").textContent = count ? `${count} scanned` : "";
  });
}

// ── Tab buttons ──────────────────────────────────────────────────────

export function setupImportTableButtons(): void {
  $("openImportTable").addEventListener("click", () => {
    chrome.tabs.create(
      { url: chrome.runtime.getURL("imports.html") },
      (tab) => {
        if (tab?.id != null) {
          chrome.storage.local.set({ [IMPORT_TAB_KEY]: tab.id });
        }
      }
    );
  });

  $("deleteImportTable").addEventListener("click", () => void deleteFinishedImportsFromPopup());

  $("openScanTable").addEventListener("click", () => {
    chrome.tabs.create(
      { url: chrome.runtime.getURL("scan-table.html") },
      (tab) => {
        if (tab?.id != null) {
          chrome.storage.local.set({ [SCAN_TAB_KEY]: tab.id });
        }
      }
    );
  });
}

// ── Job tracking & polling ───────────────────────────────────────────

export function syncFailedImportJob(
  jobId: string,
  job: { status: string; failed: number; failedItems?: unknown[] }
): boolean {
  if (!FINISHED_IMPORT_STATUSES.has(job.status)) return false;
  const wasFailed = failedImportJobs.has(jobId);
  if (job.failed > 0) failedImportJobs.add(jobId);
  else failedImportJobs.delete(jobId);
  return wasFailed !== failedImportJobs.has(jobId);
}

export async function trackImportJob(jobId: string, requested: number): Promise<void> {
  if (activeImportJobs.has(jobId)) return;
  scanStatusMessage = "";
  scanStatusClass = "";
  lastImportStatus = "";
  lastImportStatusClass = "";
  activeImportJobs.set(jobId, {
    message: `Job ${jobId.slice(0, 8)} queued ${requested} sources; waiting for backend progress…`,
  });
  recentImportJobIds.delete(jobId);
  recentImportJobIds.add(jobId);
  while (recentImportJobIds.size > 10) {
    const iterator = recentImportJobIds.values();
    const result = iterator.next();
    if (result.value !== undefined) {
      recentImportJobIds.delete(result.value);
    }
  }
  renderImportStatus();
  await persistImportJobId(jobId, true);
  void pollImportJob(jobId);
}

export async function startYoutubeImport(
  sourcePayload: unknown,
  options: SubscriptionOptions,
  requestedFallback: number
): Promise<void> {
  const response = await send("dreamedia:startYoutubeImport", {
    sourcePayload,
    ...options,
  });
  if (!response.ok) {
    throw new Error(response.error ?? "Could not queue the import.");
  }
  const result = response.data as { jobId?: string; requested?: number } | undefined;
  if (!result?.jobId) {
    throw new Error("The backend did not return an import job ID.");
  }
  const requested = Number.isFinite(result.requested)
    ? Number(result.requested)
    : requestedFallback;
  await trackImportJob(result.jobId, requested);
}

export function renderSubscriptionPreview(): void {
  const list = $("importPreview");
  list.replaceChildren();
  for (const channel of scannedSubscriptions.slice(0, 8)) {
    const item = document.createElement("li");
    item.textContent = channel.name
      ? `${channel.name} — ${channel.url}`
      : channel.url;
    list.append(item);
  }
  list.hidden = scannedSubscriptions.length === 0;
}

export async function pollImportJob(jobId: string): Promise<void> {
  if (pollingImportJobs.has(jobId) || !activeImportJobs.has(jobId)) return;
  pollingImportJobs.add(jobId);
  try {
    while (activeImportJobs.has(jobId)) {
      const response = await send("dreamedia:youtubeImportStatus", { jobId });
      if (await isImportJobHidden(jobId)) {
        forgetImportJob(jobId);
        renderImportStatus();
        break;
      }
      if (!response.ok) {
        const tracked = activeImportJobs.get(jobId);
        if (tracked) {
          tracked.message = `Job ${jobId.slice(0, 8)} progress unavailable: ${(response as { error?: string }).error}; retrying…`;
        }
        renderImportStatus();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      const job = (response as { data?: unknown }).data;
      if (!job) {
        activeImportJobs.delete(jobId);
        failedImportJobs.delete(jobId);
        await persistImportJobId(jobId);
        setImportJobStatus(
          `Import job ${jobId.slice(0, 8)} was not found for this account.`,
          "err"
        );
        break;
      }
      const jobObj = job as {
        status: string;
        requested: number;
        processed: number;
        resolved: number;
        added: number;
        skipped: number;
        failed: number;
        errors?: string[];
        failedItems?: unknown[];
      };
      const progress = `${jobObj.resolved}/${jobObj.requested} resolved · ${jobObj.processed}/${jobObj.requested} processed · ${jobObj.added} added · ${jobObj.skipped} already present · ${jobObj.failed} failed`;
      if (FINISHED_IMPORT_STATUSES.has(jobObj.status)) {
        syncFailedImportJob(jobId, jobObj);
        activeImportJobs.delete(jobId);
        terminalImportJobIds.add(jobId);
        await persistImportJobId(jobId);
        const summary = `Import ${
          jobObj.status === "completed" ? "complete" : "finished with errors"
        } (${jobId.slice(0, 8)}): ${progress}.`;
        setImportJobStatus(
          jobObj.errors?.length
            ? `${summary} ${jobObj.errors[0]}`
            : summary,
          jobObj.failed ? "err" : "ok"
        );
        if (isFullySuccessfulImport(jobObj)) {
          await deleteImportJobHistory(jobId);
        }
        break;
      }
      const tracked = activeImportJobs.get(jobId);
      if (tracked) {
        tracked.message = `Job ${jobId.slice(0, 8)} · ${
          jobObj.status === "queued" ? "Queued" : "Importing"
        }: ${progress}.`;
      }
      renderImportStatus();
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } finally {
    pollingImportJobs.delete(jobId);
  }
}

export async function refreshFailedImportJob(jobId: string): Promise<void> {
  const response = await send("dreamedia:youtubeImportStatus", { jobId });
  if (await isImportJobHidden(jobId)) {
    forgetImportJob(jobId);
    return;
  }
  if (!response.ok) return;
  const job = (response as { data?: unknown }).data;
  if (!job) {
    if (failedImportJobs.delete(jobId)) await persistImportJobId(jobId);
  } else {
    const jobObj = job as {
      status: string;
      requested: number;
      processed: number;
      added: number;
      skipped: number;
      failed: number;
    };
    if (FINISHED_IMPORT_STATUSES.has(jobObj.status)) {
      terminalImportJobIds.add(jobId);
      syncFailedImportJob(jobId, jobObj);
      if (isFullySuccessfulImport(jobObj)) {
        await deleteImportJobHistory(jobId);
      } else {
        await persistImportJobId(jobId);
      }
    }
  }
}

export async function refreshRecentImportJob(jobId: string): Promise<void> {
  if (hiddenImportJobIds.has(jobId)) return;
  const response = await send("dreamedia:youtubeImportStatus", { jobId });
  if (await isImportJobHidden(jobId)) {
    forgetImportJob(jobId);
    renderImportStatus();
    return;
  }
  if (!response.ok) return;
  const job = (response as { data?: unknown }).data;
  if (!job) {
    const historyResponse = await send("dreamedia:hideYoutubeImportHistory", { jobId });
    if (historyResponse.ok && historyResponse.data === true) {
      hiddenImportJobIds.add(jobId);
      forgetImportJob(jobId);
    }
    return;
  }

  const jobObj = job as {
    status: string;
    requested: number;
    processed: number;
    added: number;
    skipped: number;
    failed: number;
  };
  if (FINISHED_IMPORT_STATUSES.has(jobObj.status)) {
    terminalImportJobIds.add(jobId);
    syncFailedImportJob(jobId, jobObj);
    if (isFullySuccessfulImport(jobObj)) {
      await deleteImportJobHistory(jobId);
    } else {
      await persistImportJobId(jobId);
    }
    renderImportStatus();
    return;
  }

  activeImportJobs.set(jobId, {
    message: `Job ${jobId.slice(0, 8)} · restoring backend progress…`,
  });
  await persistImportJobId(jobId);
  renderImportStatus();
  void pollImportJob(jobId);
}

export async function resumeImportJobs(): Promise<void> {
  const stored = await chrome.storage.local.get([
    "youtubeImportJobIds",
    "youtubeImportJobId",
    "youtubeFailedImportJobIds",
    "youtubeRecentImportJobIds",
    "youtubeHiddenImportJobIds",
  ]);
  const hiddenIds = new Set(
    Array.isArray(stored.youtubeHiddenImportJobIds)
      ? (stored.youtubeHiddenImportJobIds as string[])
      : []
  );
  hiddenIds.forEach((jobId) => hiddenImportJobIds.add(jobId));
  const visibleId = (jobId: unknown): jobId is string =>
    typeof jobId === "string" && Boolean(jobId) && !hiddenIds.has(jobId);
  const savedIds = Array.isArray(stored.youtubeImportJobIds)
    ? stored.youtubeImportJobIds.filter(visibleId)
    : [];
  const savedFailedIds = Array.isArray(stored.youtubeFailedImportJobIds)
    ? stored.youtubeFailedImportJobIds.filter(visibleId)
    : [];
  const savedRecentIds = Array.isArray(stored.youtubeRecentImportJobIds)
    ? stored.youtubeRecentImportJobIds.filter(visibleId)
    : [];
  const jobIds = [
    ...new Set(
      [...savedIds, stored.youtubeImportJobId].filter(visibleId)
    ),
  ];
  const failedIds = [
    ...new Set(
      savedFailedIds.filter(visibleId)
    ),
  ];
  for (const jobId of savedRecentIds.slice().reverse()) {
    if (typeof jobId === "string") recentImportJobIds.add(jobId);
  }
  for (const jobId of jobIds) {
    activeImportJobs.set(jobId, {
      message: `Job ${jobId.slice(0, 8)} · restoring backend progress…`,
    });
  }
  for (const jobId of failedIds) {
    if (typeof jobId === "string" && !jobIds.includes(jobId)) {
      failedImportJobs.add(jobId);
    }
  }
  if (visibleId(stored.youtubeImportJobId)) {
    await persistImportJobId(stored.youtubeImportJobId, true);
  }
  if (stored.youtubeImportJobId) {
    await chrome.storage.local.remove("youtubeImportJobId");
  }
  for (const jobId of failedIds) {
    if (typeof jobId === "string") await refreshFailedImportJob(jobId);
  }
  const alreadyRefreshing = new Set([...jobIds, ...failedIds]);
  await Promise.all(
    savedRecentIds
      .filter((jobId): jobId is string => typeof jobId === "string" && !alreadyRefreshing.has(jobId))
      .map((jobId) => refreshRecentImportJob(jobId)),
  );
  renderImportStatus();
  for (const jobId of jobIds) {
    if (typeof jobId === "string") void pollImportJob(jobId);
  }
}
