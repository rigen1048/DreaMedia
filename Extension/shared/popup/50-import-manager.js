
function setAddSourceLabel(text) {
  $("subscribeLabel").textContent = text;
}

function renderImportStatus() {
  const jobs = Array.from(activeImportJobs.values());
  const jobMessage = jobs.length
    ? `${jobs.length > 1 ? `${jobs.length} backend batches active. ` : ""}${jobs[jobs.length - 1].message}`
    : lastImportStatus;
  const messages = [scanStatusMessage, jobMessage].filter(Boolean);
  const cls = scanStatusMessage
    ? scanStatusClass
    : (jobs.length ? "ok" : lastImportStatusClass);
  status("importStatus", messages.join(" · "), cls);
  const tableButton = $("openImportTable");
  tableButton.hidden = !activeImportJobs.size && !failedImportJobs.size && !recentImportJobIds.size;
  $("importTableMeta").textContent = activeImportJobs.size
    ? `${activeImportJobs.size} active`
    : failedImportJobs.size ? `${failedImportJobs.size} with failures` : "Recent batches";
}

function setImportScanStatus(text, cls = "") {
  scanStatusMessage = text;
  scanStatusClass = cls;
  renderImportStatus();
}

function setImportJobStatus(text, cls = "") {
  lastImportStatus = text;
  lastImportStatusClass = cls;
  renderImportStatus();
}

function persistImportJobIds() {
  const jobIds = Array.from(activeImportJobs.keys());
  const failedJobIds = Array.from(failedImportJobs);
  const recentJobIds = Array.from(recentImportJobIds).reverse().slice(0, 10);
  importJobsStorageWrite = importJobsStorageWrite
    .catch(() => {})
    .then(() => chrome.storage.local.set({
      youtubeImportJobIds: jobIds,
      youtubeFailedImportJobIds: failedJobIds,
      youtubeRecentImportJobIds: recentJobIds,
    }));
  return importJobsStorageWrite;
}

function syncFailedImportJob(jobId, job) {
  if (job.status !== "completed" && job.status !== "partial" && job.status !== "failed") return false;
  const wasFailed = failedImportJobs.has(jobId);
  if (job.failed > 0) failedImportJobs.add(jobId);
  else failedImportJobs.delete(jobId);
  return wasFailed !== failedImportJobs.has(jobId);
}

$("openImportTable").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("imports.html") }, (tab) => {
    if (tab?.id != null) chrome.storage.local.set({ importTableTabId: tab.id });
  });
});

async function trackImportJob(jobId, requested) {
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
  while (recentImportJobIds.size > 10) recentImportJobIds.delete(recentImportJobIds.values().next().value);
  renderImportStatus();
  await persistImportJobIds();
  void pollImportJob(jobId);
}

function selectedSourceOptions(forBulk = false) {
  const kind = $("kind").value;
  if (forBulk && kind === "playlist") throw new Error("Choose a channel mode, not Playlist, for scanned channels.");
  const domain = $("domain").value.trim();
  const subdomain = $("subdomain").value.trim();
  if (Boolean(domain) !== Boolean(subdomain)) {
    throw new Error("Choose both a domain and subdomain, or leave both empty.");
  }
  return {
    kind,
    words: kind === "wordscan"
      ? $("words").value.split(",").map((word) => word.trim()).filter(Boolean)
      : null,
    rank: kind === "random" ? $("rank").value : null,
    withhold: kind === "withhold" ? Math.max(1, Math.round(Number($("withhold").value) || 2)) : null,
    domain: domain || null,
    subdomain: subdomain || null,
  };
}

function renderSubscriptionPreview() {
  const list = $("importPreview");
  list.replaceChildren();
  for (const channel of scannedSubscriptions.slice(0, 8)) {
    const item = document.createElement("li");
    item.textContent = channel.name ? `${channel.name} — ${channel.url}` : channel.url;
    list.append(item);
  }
  list.hidden = scannedSubscriptions.length === 0;
}

async function pollImportJob(jobId) {
  if (pollingImportJobs.has(jobId) || !activeImportJobs.has(jobId)) return;
  pollingImportJobs.add(jobId);
  try {
    while (activeImportJobs.has(jobId)) {
      const response = await send("dreamedia:youtubeImportStatus", { jobId });
      if (!response.ok) {
        const tracked = activeImportJobs.get(jobId);
        if (tracked) tracked.message = `Job ${jobId.slice(0, 8)} progress unavailable: ${response.error}; retrying…`;
        renderImportStatus();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      const job = response.data;
      if (!job) {
        activeImportJobs.delete(jobId);
        await persistImportJobIds();
        setImportJobStatus(`Import job ${jobId.slice(0, 8)} was not found for this account.`, "err");
        break;
      }
      const progress = `${job.resolved}/${job.requested} resolved · ${job.processed}/${job.requested} processed · ${job.added} added · ${job.skipped} already present · ${job.failed} failed`;
      if (job.status === "completed" || job.status === "partial" || job.status === "failed") {
        syncFailedImportJob(jobId, job);
        activeImportJobs.delete(jobId);
        await persistImportJobIds();
        const summary = `Import ${job.status === "completed" ? "complete" : "finished with errors"} (${jobId.slice(0, 8)}): ${progress}.`;
        setImportJobStatus(job.errors?.length ? `${summary} ${job.errors[0]}` : summary, job.failed ? "err" : "ok");
        break;
      }
      const tracked = activeImportJobs.get(jobId);
      if (tracked) tracked.message = `Job ${jobId.slice(0, 8)} · ${job.status === "queued" ? "Queued" : "Importing"}: ${progress}.`;
      renderImportStatus();
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } finally {
    pollingImportJobs.delete(jobId);
  }
}

async function refreshFailedImportJob(jobId) {
  const response = await send("dreamedia:youtubeImportStatus", { jobId });
  if (!response.ok) return;
  const job = response.data;
  if (!job) {
    failedImportJobs.delete(jobId);
  } else {
    syncFailedImportJob(jobId, job);
  }
}

async function resumeImportJobs() {
  const stored = await chrome.storage.local.get([
    "youtubeImportJobIds", "youtubeImportJobId", "youtubeFailedImportJobIds", "youtubeRecentImportJobIds",
  ]);
  const savedIds = Array.isArray(stored.youtubeImportJobIds) ? stored.youtubeImportJobIds : [];
  const savedFailedIds = Array.isArray(stored.youtubeFailedImportJobIds)
    ? stored.youtubeFailedImportJobIds : [];
  const savedRecentIds = Array.isArray(stored.youtubeRecentImportJobIds)
    ? stored.youtubeRecentImportJobIds : [];
  const jobIds = [...new Set([...savedIds, stored.youtubeImportJobId]
    .filter((jobId) => typeof jobId === "string" && jobId))];
  const failedIds = [...new Set(savedFailedIds.filter((jobId) => typeof jobId === "string" && jobId))];
  for (const jobId of savedRecentIds.slice().reverse()) recentImportJobIds.add(jobId);
  for (const jobId of jobIds) {
    activeImportJobs.set(jobId, { message: `Job ${jobId.slice(0, 8)} · restoring backend progress…` });
  }
  for (const jobId of failedIds) {
    if (!jobIds.includes(jobId)) failedImportJobs.add(jobId);
  }
  if (stored.youtubeImportJobId || !Array.isArray(stored.youtubeImportJobIds) || jobIds.length !== savedIds.length) {
    await persistImportJobIds();
    if (stored.youtubeImportJobId) await chrome.storage.local.remove("youtubeImportJobId");
  }
  for (const jobId of failedIds) await refreshFailedImportJob(jobId);
  await persistImportJobIds();
  renderImportStatus();
  for (const jobId of jobIds) void pollImportJob(jobId);
}
