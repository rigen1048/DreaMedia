/**
 * DreaMedia PopUI — Import Table Page
 * Dedicated page for viewing and managing YouTube import batches.
 * Shows job selector, progress bar, per-channel status table, and retry button.
 * No `any` type permitted.
 */

export {};

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element: #${id}`);
  return el;
};

function send(
  type: string,
  extra: Record<string, unknown> = {}
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type, ...extra },
      (resp) => {
        resolve(
          resp || { ok: false, error: chrome.runtime.lastError?.message ?? "No response" }
        );
      }
    );
  });
}

const ACTIVE_KEY = "youtubeImportJobIds";
const FAILED_KEY = "youtubeFailedImportJobIds";
const RECENT_KEY = "youtubeRecentImportJobIds";
const RECENT_LIMIT = 10;
const TERMINAL = new Set(["completed", "partial", "failed"]);

interface ImportItem {
  ordinal: number;
  link: string;
  status: string;
  error: string | null;
  retryable: boolean;
}

interface ImportJob {
  jobId: string;
  status: string;
  requested: number;
  processed: number;
  resolved: number;
  added: number;
  skipped: number;
  failed: number;
  errors: string[];
  items: ImportItem[] | null;
  error?: string;
  missing?: boolean;
  viewSignature?: string;
  retrying?: boolean;
}

const jobs = new Map<string, ImportJob>();
const refreshingJobs = new Set<string>();
let selectedJobId = "";
let polling = false;

function uniqueIds(...lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

function terminal(job: ImportJob | { jobId: string } | undefined): job is ImportJob {
  if (!job) return false;
  return "status" in job && TERMINAL.has(job.status);
}

function itemCounts(job: ImportJob): { added: number; skipped: number; failed: number; working: number } {
  const items = Array.isArray(job.items) ? job.items : [];
  const counts = { added: 0, skipped: 0, failed: 0, working: 0 };
  for (const item of items) {
    if (item.status === "added") counts.added += 1;
    else if (item.status === "skipped") counts.skipped += 1;
    else if (item.status === "failed") counts.failed += 1;
    else counts.working += 1;
  }
  if (!items.length) {
    counts.failed = Number(job.failed) || 0;
    counts.added = Number(job.added) || 0;
    counts.skipped = Number(job.skipped) || 0;
    counts.working = Math.max(0, (Number(job.requested) || 0) - (Number(job.processed) || 0));
  }
  return counts;
}

function statusLabel(status: string): string {
  return ({
    queued: "Queued",
    resolving: "Resolving",
    resolved: "Resolved",
    processing: "Adding",
    running: "Adding",
    added: "Added",
    skipped: "Already present",
    failed: "Failed",
    completed: "Complete",
    partial: "Finished with errors",
  } as Record<string, string>)[status] ?? "Waiting";
}

function batchLabel(job: ImportJob): string {
  const counts = itemCounts(job);
  const requested = Number(job.requested) || (Array.isArray(job.items) ? job.items.length : 0);
  const finished = counts.added + counts.skipped + counts.failed;
  return `Job ${job.jobId.slice(0, 8)} · ${statusLabel(job.status)} · ${finished}/${requested}`;
}

function renderSelector(): void {
  const select = $("jobSelect") as HTMLSelectElement;
  const ids = [...jobs.keys()];
  select.replaceChildren();
  for (const jobId of ids) {
    const job = jobs.get(jobId);
    const option = document.createElement("option");
    option.value = jobId;
    option.textContent = job ? batchLabel(job) : `Job ${jobId.slice(0, 8)}`;
    select.append(option);
  }
  if (!jobs.has(selectedJobId)) selectedJobId = ids[0] ?? "";
  select.value = selectedJobId;
}

function rowState(status: string): { label: string; mark: string; className: string; result: string } {
  if (status === "added")
    return { label: "Added", mark: "✓", className: "added", result: "Added to DreaMedia" };
  if (status === "skipped")
    return { label: "Already present", mark: "✓", className: "skipped", result: "No duplicate source was created" };
  if (status === "failed")
    return { label: "Failed", mark: "!", className: "failed", result: "Could not add this channel" };
  if (status === "resolving")
    return { label: "Resolving", mark: "·", className: "resolving", result: "Finding the YouTube channel" };
  if (status === "resolved")
    return { label: "Resolved", mark: "·", className: "processing", result: "Waiting to add the source" };
  if (status === "processing" || status === "running")
    return { label: "Adding", mark: "·", className: "processing", result: "Saving source to DreaMedia" };
  return { label: "Queued", mark: "·", className: "queued", result: "Waiting in the import queue" };
}

function safeYoutubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["youtube.com", "www.youtube.com"].includes(url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function cleanError(link: string, error: string): string {
  const value = error ?? "Could not add this channel";
  return link && value.startsWith(`${link}: `) ? value.slice(link.length + 2) : value;
}

function renderRows(job: ImportJob): void {
  const body = $("itemRows");
  const noRows = $("noRows");
  body.replaceChildren();
  const items = Array.isArray(job.items) ? job.items : [];
  noRows.hidden = items.length > 0;
  if (!Array.isArray(job.items)) {
    noRows.textContent = "Loading channel rows…";
    return;
  }
  if (!items.length) {
    noRows.textContent = Number(job.requested) > 0
      ? "Channel rows are unavailable. Reconnect to DreaMedia and refresh."
      : "This import contains no channels.";
    return;
  }

  for (const item of items) {
    const state = rowState(item.status);
    const row = document.createElement("tr");
    const number = document.createElement("td");
    number.className = "row-number";
    number.textContent = String(Number(item.ordinal) + 1);
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `row-status state-${state.className}`;
    const mark = document.createElement("span");
    mark.className = "state-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = state.mark;
    const label = document.createElement("span");
    label.textContent = state.label;
    badge.append(mark, label);
    statusCell.append(badge);

    const channelCell = document.createElement("td");
    if (safeYoutubeUrl(item.link)) {
      const link = document.createElement("a");
      link.className = "channel-link";
      link.href = item.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = item.link;
      channelCell.append(link);
    } else {
      const link = document.createElement("span");
      link.className = "channel-link";
      link.textContent = item.link || "Unknown channel link";
      channelCell.append(link);
    }

    const resultCell = document.createElement("td");
    resultCell.className = `row-result${item.status === "failed" ? " error" : ""}`;
    resultCell.textContent = item.status === "failed"
      ? cleanError(item.link, item.error ?? "")
      : state.result;
    row.append(number, statusCell, channelCell, resultCell);
    body.append(row);
  }
}

function announceItemChanges(previousItems: ImportItem[], nextItems: ImportItem[]): void {
  const previousStatuses = new Map(previousItems.map((item) => [item.ordinal, item.status]));
  const changed = nextItems.filter((item) =>
    previousStatuses.has(item.ordinal) && previousStatuses.get(item.ordinal) !== item.status
  );
  if (!changed.length) return;
  const details = changed.slice(0, 5).map((item) => {
    const channel = item.link.split("/").filter(Boolean).pop() ?? `row ${item.ordinal + 1}`;
    return `Channel ${channel}: ${statusLabel(item.status)}`;
  });
  const remaining = changed.length - details.length;
  $("rowAnnouncement").textContent = `${changed.length} channel${changed.length === 1 ? "" : "s"} updated: ${details.join(". ")}${remaining ? `. And ${remaining} more.` : "."}`;
}

function renderCurrent(): void {
  renderSelector();
  const job = jobs.get(selectedJobId);
  const pageMessage = $("pageMessage");
  if (!job) {
    $("importView").hidden = true;
    pageMessage.hidden = false;
    pageMessage.className = "page-message";
    pageMessage.textContent = "No imports yet. Start a batch with Scan subscriptions in the DreaMedia popup.";
    return;
  }

  $("importView").hidden = false;
  const hasData = Array.isArray(job.items) || Boolean(job.status);
  pageMessage.hidden = !job.error && !job.missing && hasData;
  if (job.error) {
    pageMessage.className = "page-message error";
    pageMessage.textContent = job.error;
  } else if (job.missing) {
    pageMessage.className = "page-message";
    pageMessage.textContent = "This import is no longer available on the backend.";
  } else {
    pageMessage.textContent = "Loading import details…";
  }

  const counts = itemCounts(job);
  const requested = Number(job.requested) || (Array.isArray(job.items) ? job.items.length : 0);
  const finished = counts.added + counts.skipped + counts.failed;
  const percent = requested ? Math.min(100, Math.round((finished / requested) * 100)) : 0;
  const progressParent = $("progressFill").parentElement;
  if (progressParent) {
    progressParent.setAttribute("aria-valuenow", String(percent));
  }
  const progressFill = $("progressFill") as HTMLElement;
  progressFill.style.width = `${percent}%`;
  $("batchStatus").textContent = statusLabel(job.status);
  $("batchProgress").textContent = `${finished} / ${requested} processed`;
  $("doneCount").className = "done-count";
  $("doneCount").textContent = `${counts.added} added · ${counts.skipped} already present`;
  $("failedCount").className = counts.failed ? "failed-count" : "";
  $("failedCount").textContent = `${counts.failed} failed`;

  const allItems = Array.isArray(job.items) ? job.items : [];
  const retryable = allItems.filter((item) => item.retryable).length;
  const retryButton = $("retryFailed") as HTMLButtonElement;
  retryButton.hidden = retryable === 0;
  retryButton.disabled = !terminal(job) || Boolean(job.retrying);
  retryButton.textContent = job.retrying
    ? "Queueing retry…"
    : terminal(job)
      ? `Retry ${retryable} failed`
      : `Retry ${retryable} when complete`;
  retryButton.title = retryButton.disabled && !job.retrying
    ? "Wait for this batch to finish"
    : "Retry retryable failed channels";
  renderRows(job);
}

async function updateStoredJob(job: ImportJob, starting = false): Promise<void> {
  const isTerminal = TERMINAL.has(job.status);
  if (!isTerminal && !starting) return;
  const stored = await chrome.storage.local.get([ACTIVE_KEY, FAILED_KEY, RECENT_KEY]);
  let active = Array.isArray(stored[ACTIVE_KEY]) ? (stored[ACTIVE_KEY] as string[]) : [];
  let failed = Array.isArray(stored[FAILED_KEY]) ? (stored[FAILED_KEY] as string[]) : [];
  let recent = Array.isArray(stored[RECENT_KEY]) ? (stored[RECENT_KEY] as string[]) : [];
  recent = uniqueIds([job.jobId], recent).slice(0, RECENT_LIMIT);
  if (isTerminal) {
    active = active.filter((id) => id !== job.jobId);
    failed = job.failed > 0 ? uniqueIds(failed, [job.jobId]) : failed.filter((id) => id !== job.jobId);
  } else {
    active = uniqueIds(active, [job.jobId]);
    failed = failed.filter((id) => id !== job.jobId);
  }
  await chrome.storage.local.set({
    [ACTIVE_KEY]: active,
    [FAILED_KEY]: failed,
    [RECENT_KEY]: recent,
  });
}

async function refreshJob(jobId: string): Promise<void> {
  if (refreshingJobs.has(jobId)) return;
  refreshingJobs.add(jobId);
  let loadDetails = false;
  try {
    const includeItems = jobId === selectedJobId;
    const response = await send("dreamedia:youtubeImportStatus", { jobId, includeItems });
    const current = jobs.get(jobId) ?? ({ jobId, status: "queued", requested: 0, processed: 0, resolved: 0, added: 0, skipped: 0, failed: 0, errors: [], items: null } as ImportJob);
    if (!response.ok) {
      current.error = (response as { error?: string }).error ?? "Could not load import status. Check the DreaMedia connection and refresh.";
      jobs.set(jobId, current);
      if (jobId === selectedJobId) renderCurrent();
      return;
    }
    if (!(response as { data?: unknown }).data) {
      current.missing = true;
      current.items = [];
      jobs.set(jobId, current);
      if (jobId === selectedJobId) renderCurrent();
      return;
    }
    const previous = current.viewSignature;
    const currentItems = current.items;
    const data = (response as { data: ImportJob }).data;
    Object.assign(current, data, { error: "", missing: false });
    if (!includeItems) current.items = currentItems ?? null;
    else if (jobId === selectedJobId) announceItemChanges(currentItems ?? [], current.items ?? []);
    loadDetails = !includeItems && jobId === selectedJobId && current.items == null;
    current.viewSignature = JSON.stringify([current.status, current.processed, current.items]);
    jobs.set(jobId, current);
    if (terminal(current)) await updateStoredJob(current);
    if (current.viewSignature !== previous) {
      if (jobId === selectedJobId) renderCurrent();
      else renderSelector();
    }
  } finally {
    refreshingJobs.delete(jobId);
    if (loadDetails) void refreshJob(jobId);
  }
}

async function retryJob(): Promise<void> {
  const job = jobs.get(selectedJobId);
  if (!job || !terminal(job)) return;
  job.retrying = true;
  renderCurrent();
  const response = await send("dreamedia:retryYoutubeImport", { jobId: job.jobId });
  job.retrying = false;
  if (!response.ok || !(response as { data?: { jobId?: string } }).data?.jobId) {
    job.error = (response as { error?: string }).error ?? "Could not queue failed channels for retry.";
    renderCurrent();
    return;
  }
  const retryData = (response as { data: ImportJob }).data;
  const retry: ImportJob = {
    ...retryData,
    jobId: retryData.jobId,
    items: null,
    status: retryData.status,
    requested: 0,
    processed: 0,
    resolved: 0,
    added: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  jobs.set(retry.jobId, retry);
  selectedJobId = retry.jobId;
  await updateStoredJob(retry, true);
  renderCurrent();
  await refreshJob(retry.jobId);
}

async function loadJobs(): Promise<void> {
  const stored = await chrome.storage.local.get([ACTIVE_KEY, FAILED_KEY, RECENT_KEY]);
  const recentIds = Array.isArray(stored[RECENT_KEY]) ? (stored[RECENT_KEY] as string[]) : [];
  const activeIds = Array.isArray(stored[ACTIVE_KEY]) ? (stored[ACTIVE_KEY] as string[]) : [];
  const failedIds = Array.isArray(stored[FAILED_KEY]) ? (stored[FAILED_KEY] as string[]) : [];
  const ids = uniqueIds(recentIds, activeIds, failedIds);
  for (const jobId of ids) {
    jobs.set(jobId, { jobId, status: "queued", requested: 0, processed: 0, resolved: 0, added: 0, skipped: 0, failed: 0, errors: [], items: null });
  }
  selectedJobId = ids[0] ?? "";
  renderCurrent();
  if (!ids.length) return;
  await Promise.all(ids.map((jobId) => refreshJob(jobId)));
  if (!polling) {
    polling = true;
    setInterval(() => {
      for (const [jobId, job] of jobs) {
        const isTerminal = TERMINAL.has(job.status);
        if (!isTerminal && !job.missing) void refreshJob(jobId);
      }
    }, 1500);
  }
}

$("jobSelect").addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  selectedJobId = target.value;
  renderCurrent();
  void refreshJob(selectedJobId);
});
$("refreshJobs").addEventListener("click", () => {
  for (const jobId of jobs.keys()) void refreshJob(jobId);
  if (!jobs.size) void loadJobs();
});
$("retryFailed").addEventListener("click", () => void retryJob());
$("closePage").addEventListener("click", () => {
  chrome.storage.local.get("importTableTabId", (result) => {
    const tabId = result.importTableTabId;
    if (tabId != null) chrome.tabs.remove(tabId);
    chrome.storage.local.remove("importTableTabId");
  });
});
void loadJobs();
