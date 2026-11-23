/* DreaMedia popup (D55): subscribe-from-page (HydraTracker model),
 * playlist add, and anime binding for the content script's watch tracking. */
const $ = (id) => document.getElementById(id);

function send(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
      resolve(resp || { ok: false, error: chrome.runtime.lastError?.message || "No response" });
    });
  });
}

function status(id, text, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let trackingRequestInFlight = false;
let animeTrackingSite = false;
let animeTrackingEnabled = false;

function formatClock(value) {
  if (!Number.isFinite(value) || value < 0) return "—:—";
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function renderTracking(data) {
  const card = $("trackingCard");
  const title = $("trackingTitle");
  const detail = $("trackingDetail");
  const clock = $("trackingTime");
  if (!data) {
    card.dataset.state = "idle";
    title.textContent = !animeTrackingEnabled ? "Anime tracking paused" : "Starting anime tracking…";
    detail.textContent = !animeTrackingEnabled
      ? "Enable this domain to match the page and video"
      : "Matching the page title and locating the video";
    clock.textContent = "—:—";
    return;
  }
  if (!data.bound || !data.entryId) {
    card.dataset.state = "idle";
    const pageTitle = String(data.pageTitle || "").trim();
    title.textContent = data.state === "matching"
      ? (pageTitle || "Matching page title…")
      : "No tracked anime match";
    detail.textContent = data.state === "matching"
      ? (data.urlEpisode != null
        ? `Matching tracked titles · URL suggests episode ${data.urlEpisode}`
        : "Matching this page title against tracked anime")
      : (data.urlEpisode != null
        ? `Page: ${pageTitle || "unknown title"} · URL suggests episode ${data.urlEpisode}`
        : `Page: ${pageTitle || "unknown title"}`);
    clock.textContent = "—:—";
    return;
  }

  const animeTitle = data.title || `Anime ${data.entryId}`;
  const season = Number(data.season) > 0 ? `S${data.season} · ` : "";
  const episode = data.episode != null ? `Episode ${data.episode}` : "Episode unknown";
  const sources = { url: "URL", title: "title", cursor: "saved cursor", ended: "ended +1" };
  const source = sources[data.episodeSource] || data.episodeSource || "estimate";
  const stateText = {
    playing: "Tracking",
    paused: "Paused",
    waiting: "Waiting for video",
    ended: data.episodeSource === "ended" ? "Next episode estimate" : "Episode ended",
    unmatched: "Not matched",
  }[data.state] || "Tracking";
  card.dataset.state = data.state === "playing" || data.state === "paused" || data.state === "ended"
    ? data.state : "idle";
  title.textContent = animeTitle;
  detail.textContent = `${stateText} · ${season}${episode} · ${source}`;
  const current = formatClock(data.positionSeconds);
  const total = formatClock(data.durationSeconds);
  clock.textContent = data.durationSeconds != null && total !== "—:—"
    ? `${current} / ${total}` : current;
}

async function refreshTrackingStatus() {
  if (trackingRequestInFlight) return;
  trackingRequestInFlight = true;
  try {
    const tab = await currentTab();
    if (!tab?.id) {
      renderTracking(null);
      return;
    }
    if (!animeTrackingSite) {
      renderTracking(null);
      return;
    }
    const response = await send("dreamedia:trackingStatus", { tabId: tab.id });
    renderTracking(response.ok ? response.data : null);
  } catch (_error) {
    renderTracking(null);
  } finally {
    trackingRequestInFlight = false;
  }
}

function setConnection(state, text) {
  $("connection").dataset.state = state;
  $("connectionText").textContent = text;
}

function applyConnectionState(data) {
  const labels = {
    idle: ["idle", data.reason === "No enabled site open" ? "Open an enabled site" : "Not connected"],
    connected: ["ok", "Connected (WebSocket)"],
    connecting: ["loading", data.reason === "Reconnecting" ? "Reconnecting…" : "Connecting…"],
    disconnected: ["err", "Disconnected"],
  };
  const [state, text] = labels[data.status] || labels.disconnected;
  setConnection(state, text);
  $("connection").title = data.reason || "";
}

async function syncConnectionStatus() {
  const response = await send("dreamedia:connectionStatus");
  if (response.ok && response.data) applyConnectionState(response.data);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "dreamedia:connectionStatus") applyConnectionState(message);
});

function action(buttonId, statusId, run) {
  const button = $(buttonId);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      status(statusId, `Failed: ${error.message}`, "err");
    } finally {
      button.disabled = false;
    }
  });
}

const tabs = [...document.querySelectorAll('[role="tab"]')];
let chooseInitialTab = true;
let page = { kind: "none", playlist: false, subscriptionChannels: false };
let currentUrl = "";

function describePage(raw) {
  try {
    const url = new URL(raw);
    const youtube = /(^|\.)youtube\.com$/i.test(url.hostname);
    const shortLink = url.hostname === "youtu.be";
    const subscriptionChannels = youtube && url.pathname === "/feed/channels";
    const video = (shortLink && url.pathname.length > 1) || (youtube && (
      (url.pathname === "/watch" && url.searchParams.has("v")) ||
      /^\/(?:shorts|live|embed)\/[^/]+/.test(url.pathname)
    ));
    const channel = youtube && /^\/(?:@[^/]+|channel\/UC[^/]+)/.test(url.pathname);
    return {
      kind: video ? "video" : channel ? "channel" : youtube || shortLink ? "youtube" : "other",
      playlist: (youtube || shortLink) && Boolean(url.searchParams.get("list")),
      subscriptionChannels,
    };
  } catch {
    return { kind: "none", playlist: false, subscriptionChannels: false };
  }
}

function selectTab(selected) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !active;
  }
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => {
    chooseInitialTab = false;
    selectTab(tab);
  });
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    chooseInitialTab = false;
    selectTab(tabs[next]);
    tabs[next].focus();
  });
}

function showSettings(show, focus = true) {
  $("actions").hidden = show;
  $("setup").hidden = !show;
  $("openSettings").hidden = show;
  $("closeSettings").hidden = !show;
  if (focus) $(show ? "setupTitle" : "openSettings").focus();
}
$("openSettings").addEventListener("click", () => showSettings(true));
$("closeSettings").addEventListener("click", () => showSettings(false));
const version = chrome.runtime.getManifest?.().version;
if (version) $("version").textContent = version;

// ---- config ----
async function loadConfiguration() {
  let configured = false;
  const cfg = await chrome.storage.local.get(["backendUrl", "token"]);
  if (cfg.backendUrl) $("backendUrl").value = cfg.backendUrl;
  if (cfg.token) $("token").value = cfg.token;
  configured = Boolean(cfg.token);
  if (!configured) {
    setConnection("idle", "Not connected");
    showSettings(true, false);
  } else {
    await syncConnectionStatus();
  }
  return configured;
}

action("saveConfig", "configStatus", async () => {
  const backendUrl = $("backendUrl").value.trim();
  const token = $("token").value.trim();
  let parsedBackendUrl;
  try { parsedBackendUrl = new URL(backendUrl); } catch (_e) { throw new Error("Enter a valid HTTP or HTTPS backend URL."); }
  if (parsedBackendUrl.protocol !== "http:" && parsedBackendUrl.protocol !== "https:") {
    throw new Error("Enter a valid HTTP or HTTPS backend URL.");
  }
  if (!token) throw new Error("Enter the extension token.");
  await chrome.storage.local.set({ backendUrl, token, domains: null });
  status("configStatus", "Connecting by WebSocket…");
  const connection = await send("dreamedia:connect");
  if (!connection.ok) throw new Error(connection.error || "WebSocket authentication failed.");
  applyConnectionState(connection.data);
  if (connection.data?.status === "idle" && connection.data?.reason === "No enabled site open") {
    status("configStatus", "Saved. Open YouTube or another enabled site to connect.", "ok");
    showSettings(false);
    return;
  }
  status("configStatus", "WebSocket connected.", "ok");
  const refreshed = await send("dreamedia:refreshDomains");
  if (!refreshed.ok) throw new Error(refreshed.error || "Background refresh failed");
  await loadLists(true, false);
  await checkSite();
  await syncConnectionStatus();
  showSettings(false);
});

// ---- this site (ext v2: domain allowlist) ----
async function checkSite() {
  const tab = await currentTab();
  const badge = $("siteBadge");
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    currentUrl = "";
    $("siteHost").textContent = "No web page open";
    $("siteEnable").hidden = true;
    badge.hidden = true;
    showSubscriptionFields();
    return;
  }
  currentUrl = tab.url;
  page = describePage(tab.url);
  const r = await send("dreamedia:domainStatus", { url: tab.url });
  const host = r.host || new URL(tab.url).hostname;
  $("siteHost").textContent = host;
  const videoSite = r.registered?.media === "yt" || ["youtube", "video", "channel"].includes(page.kind);
  $("siteIcon").querySelector("use").setAttribute("href", videoSite ? "#video" : "#globe");
  animeTrackingSite = r.registered?.media === "ani";
  animeTrackingEnabled = animeTrackingSite && r.registered.enabled !== false;
  $("trackingCard").hidden = !animeTrackingSite;
  $("pageActions").hidden = animeTrackingSite;
  $("subscribePanel").hidden = animeTrackingSite;
  $("playlistPanel").hidden = animeTrackingSite;
  if (chooseInitialTab && !animeTrackingSite) {
    chooseInitialTab = false;
    const initialTab = page.kind === "video" ? "playlistTab" : "subscribeTab";
    selectTab($(initialTab));
    if (initialTab === "subscribeTab" && page.kind === "youtube" && page.playlist) $("kind").value = "playlist";
  }
  showSubscriptionFields();
  if (!r.ok) {
    badge.hidden = true;
    $("siteEnable").hidden = true;
    status("siteStatus", `Couldn’t check this site: ${r.error}`, "err");
    return;
  }
  const listed = Boolean(r.registered);
  const enabled = listed && r.registered.enabled !== false;
  badge.hidden = false;
  badge.textContent = enabled ? "Enabled" : listed ? "Paused" : "Not enabled";
  badge.classList.toggle("enabled", enabled);
  const media = r.registered?.media === "ani" ? "Anime" : "YouTube";
  badge.title = listed ? `${media} · ${enabled ? "Enabled" : "Paused in DreaMedia"}` : "";
  $("siteEnable").hidden = listed;
  $("siteMediaWrap").hidden = listed;
  $("enableSite").textContent = "Enable site";
  if (listed && !enabled) status("siteStatus", "Resume this site in DreaMedia → Ext → Sites.");
  else if ($("siteStatus").classList.contains("err")) status("siteStatus", "");
}

action("enableSite", "siteStatus", async () => {
  const pageUrl = currentUrl;
  if (!pageUrl) return status("siteStatus", "Open a web page first", "err");
  status("siteStatus", "Adding site to DreaMedia…");
  const r = await send("dreamedia:addDomain", {
    domain: pageUrl,
    media: $("siteMedia").value,
  });
  status("siteStatus", r.ok ? "Site added. Anime matching and video tracking start automatically." : `Failed: ${r.error}`, r.ok ? "ok" : "err");
  if (r.ok) {
    await checkSite();
    $("siteHost").focus();
  }
});
// ---- conditional fields ----
function showSubscriptionFields() {
  const kind = $("kind").value;
  $("wordsField").hidden = kind !== "wordscan";
  $("rankField").hidden = kind !== "random";
  $("withholdField").hidden = kind !== "withhold";
}
$("kind").addEventListener("change", showSubscriptionFields);
showSubscriptionFields();

let categories = [];
let lastCategoryDomainValue = "";
function fillDatalist(id, values) {
  const list = $(id);
  list.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    list.append(option);
  }
}
function updateCategorySuggestions() {
  const domainName = $("domain").value.trim();
  if (domainName.toLowerCase() !== lastCategoryDomainValue.toLowerCase()) {
    $("subdomain").value = "";
    lastCategoryDomainValue = domainName;
  }
  const domain = categories.find((row) => row.name.toLowerCase() === domainName.toLowerCase());
  const subdomainInput = $("subdomain");
  subdomainInput.disabled = !domainName;
  subdomainInput.placeholder = domainName ? "Existing or new subdomain" : "Choose a domain first";
  fillDatalist("subdomainSuggestions", (domain?.subdomains || []).map((row) => row.name));
}
$("domain").addEventListener("input", updateCategorySuggestions);

let scannedSubscriptions = [];
let subscriptionScanComplete = false;
const activeImportJobs = new Map();
const failedImportJobs = new Map();
const pollingImportJobs = new Set();
let importJobsStorageWrite = Promise.resolve();
let scanStatusMessage = "";
let scanStatusClass = "";
let lastImportStatus = "";
let lastImportStatusClass = "";

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
  const failedJobIds = Array.from(failedImportJobs.keys());
  importJobsStorageWrite = importJobsStorageWrite
    .catch(() => {})
    .then(() => chrome.storage.local.set({
      youtubeImportJobIds: jobIds,
      youtubeFailedImportJobIds: failedJobIds,
    }));
  return importJobsStorageWrite;
}

function renderFailedImportJobs() {
  const details = $("failedImports");
  const list = $("failedImportList");
  list.replaceChildren();
  let total = 0;
  for (const job of failedImportJobs.values()) total += job.items.length;
  details.hidden = total === 0;
  $("failedImportSummary").textContent = `Failed channels (${total})`;

  for (const job of failedImportJobs.values()) {
    if (!job.items.length) continue;
    const retryableCount = job.items.filter((item) => item.retryable).length;
    const jobRow = document.createElement("li");
    jobRow.className = "failed-import-job";
    const heading = document.createElement("div");
    heading.className = "failed-import-job-heading";
    const label = document.createElement("span");
    label.textContent = `Import ${job.jobId.slice(0, 8)} · ${job.items.length} failed`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "secondary failed-import-retry";
    retry.textContent = retryableCount ? `Retry ${retryableCount}` : "No retryable links";
    retry.disabled = retryableCount === 0;
    retry.addEventListener("click", () => void retryFailedImportJob(job.jobId, retry));
    heading.append(label, retry);

    const itemList = document.createElement("ul");
    itemList.className = "failed-import-items";
    for (const failure of job.items) {
      const item = document.createElement("li");
      const link = document.createElement("span");
      link.textContent = failure.link || "Unknown channel link";
      const error = document.createElement("span");
      error.className = "failed-import-error";
      const detail = failure.error || "Import failed";
      error.textContent = failure.link && detail.startsWith(`${failure.link}: `)
        ? detail.slice(failure.link.length + 2)
        : detail;
      item.append(link, error);
      itemList.append(item);
    }
    jobRow.append(heading, itemList);
    list.append(jobRow);
  }
}

async function retryFailedImportJob(jobId, button) {
  button.disabled = true;
  let response;
  try {
    response = await send("dreamedia:retryYoutubeImport", { jobId });
  } catch (error) {
    button.disabled = false;
    setImportScanStatus(`Retry failed: ${error.message || "Could not queue failed channels."}`, "err");
    return;
  }
  if (!response.ok) {
    button.disabled = false;
    setImportScanStatus(`Retry failed: ${response.error || "Could not queue failed channels."}`, "err");
    return;
  }
  const retryJob = response.data;
  if (!retryJob?.jobId) {
    button.disabled = false;
    setImportScanStatus("Retry failed: the backend did not return a job ID.", "err");
    return;
  }
  failedImportJobs.delete(jobId);
  renderFailedImportJobs();
  await trackImportJob(retryJob.jobId, retryJob.requested || 0);
}

async function trackImportJob(jobId, requested) {
  if (activeImportJobs.has(jobId)) return;
  scanStatusMessage = "";
  scanStatusClass = "";
  lastImportStatus = "";
  lastImportStatusClass = "";
  activeImportJobs.set(jobId, {
    message: `Job ${jobId.slice(0, 8)} queued ${requested} sources; waiting for backend progress…`,
  });
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
      if (job.status === "completed" || job.status === "partial") {
        activeImportJobs.delete(jobId);
        const failures = Array.isArray(job.failedItems) ? job.failedItems : [];
        if (failures.length) failedImportJobs.set(jobId, { jobId, items: failures });
        else if (!job.failed) failedImportJobs.delete(jobId);
        else failedImportJobs.set(jobId, { jobId, items: [] });
        renderFailedImportJobs();
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
  } else if (job.failedItems?.length) {
    failedImportJobs.set(jobId, { jobId, items: job.failedItems });
  } else if (!job.failed) {
    failedImportJobs.delete(jobId);
  } else {
    failedImportJobs.set(jobId, { jobId, items: [] });
  }
}

async function resumeImportJobs() {
  const stored = await chrome.storage.local.get([
    "youtubeImportJobIds", "youtubeImportJobId", "youtubeFailedImportJobIds",
  ]);
  const savedIds = Array.isArray(stored.youtubeImportJobIds) ? stored.youtubeImportJobIds : [];
  const savedFailedIds = Array.isArray(stored.youtubeFailedImportJobIds)
    ? stored.youtubeFailedImportJobIds : [];
  const jobIds = [...new Set([...savedIds, stored.youtubeImportJobId]
    .filter((jobId) => typeof jobId === "string" && jobId))];
  const failedIds = [...new Set(savedFailedIds.filter((jobId) => typeof jobId === "string" && jobId))];
  for (const jobId of jobIds) {
    activeImportJobs.set(jobId, { message: `Job ${jobId.slice(0, 8)} · restoring backend progress…` });
  }
  for (const jobId of failedIds) {
    if (!failedImportJobs.has(jobId)) failedImportJobs.set(jobId, { jobId, items: [] });
  }
  if (stored.youtubeImportJobId || !Array.isArray(stored.youtubeImportJobIds) || jobIds.length !== savedIds.length) {
    await persistImportJobIds();
    if (stored.youtubeImportJobId) await chrome.storage.local.remove("youtubeImportJobId");
  }
  for (const jobId of failedIds) await refreshFailedImportJob(jobId);
  renderFailedImportJobs();
  await persistImportJobIds();
  renderImportStatus();
  for (const jobId of jobIds) void pollImportJob(jobId);
}

action("scanSubscriptions", "importStatus", async () => {
  scannedSubscriptions = [];
  subscriptionScanComplete = false;
  setAddSourceLabel("Add source");
  $("importPreview").hidden = true;
  const tab = await currentTab();
  if (!tab?.id) {
    setImportScanStatus("Open YouTube's channel subscriptions page first.", "err");
    return;
  }
  setImportScanStatus("Scanning the page and loading more channels…");
  const response = await send("dreamedia:scanYoutubeSubscriptions", { tabId: tab.id });
  if (!response.ok) {
    setImportScanStatus(response.error || "Subscription scan failed.", "err");
    return;
  }
  scannedSubscriptions = Array.isArray(response.data?.channels) ? response.data.channels : [];
  subscriptionScanComplete = response.data?.complete === true;
  renderSubscriptionPreview();
  if (!scannedSubscriptions.length) {
    setImportScanStatus("No channel links found. Check that this is the channel subscriptions page and you are signed in.", "err");
    return;
  }
  if (subscriptionScanComplete) {
    const count = scannedSubscriptions.length;
    setAddSourceLabel(`Add ${count} ${count === 1 ? "source" : "sources"}`);
    setImportScanStatus(`${scannedSubscriptions.length} unique channel(s) found. Review the preview, then choose Add sources.`, "ok");
  } else {
    setImportScanStatus(`Found ${scannedSubscriptions.length}, but the page did not reach a stable end. Scroll through the page and scan again before adding sources.`, "err");
  }
});

// ---- subscribe ----
action("subscribe", "subStatus", async () => {
  if (page.subscriptionChannels && !subscriptionScanComplete) {
    throw new Error("Scan the complete channel list first; Add Source will add each scanned channel.");
  }
  if (subscriptionScanComplete) {
    if (!scannedSubscriptions.length) throw new Error("Scan the channel list before adding sources.");
    const options = selectedSourceOptions(true);
    const response = await send("dreamedia:startYoutubeImport", {
      links: scannedSubscriptions.map((channel) => channel.url),
      ...options,
    });
    if (!response.ok) throw new Error(response.error || "Could not queue the channel import.");
    const jobId = response.data?.jobId;
    if (!jobId) throw new Error("The backend did not return an import job ID.");
    const count = scannedSubscriptions.length;
    scannedSubscriptions = [];
    subscriptionScanComplete = false;
    renderSubscriptionPreview();
    setAddSourceLabel("Add source");
    await trackImportJob(jobId, count);
    return;
  }
  const tab = await currentTab();
  if (!tab?.url) return status("subStatus", "Open a YouTube page first", "err");
  const body = { ...selectedSourceOptions(), link: tab.url };
  status("subStatus", "Subscribing…");
  const r = await send("dreamedia:subscribe", { body });
  const subscribed = r.ok && r.data?.ok;
  status("subStatus", subscribed ? "Source added" : `Couldn’t add source: ${r.error || r.data?.error || "Unknown error"}`, subscribed ? "ok" : "err");
});

// ---- playlist add ----
action("addVideo", "cardStatus", async () => {
  const tab = await currentTab();
  if (!tab?.url) return status("cardStatus", "Open a video page first", "err");
  const cardId = $("card").value;
  if (!cardId) return status("cardStatus", "Pick a playlist first", "err");
  status("cardStatus", "Adding video…");
  const r = await send("dreamedia:addItem", { cardId, links: [tab.url] });
  const added = Boolean(r.ok && r.data?.added > 0);
  const duplicate = Boolean(r.ok && r.data && r.data.added === 0 && r.data.requested > 0 && !r.data.errors?.length);
  const reason = r.data?.errors?.[0]?.replace(`${tab.url}: `, "") || r.error;
  status("cardStatus", added ? "Video added" : duplicate ? "Already in this playlist" : reason || "No video was added", added || duplicate ? "ok" : "err");
});

// ---- lists ----
function fillOptions(select, rows, emptyLabel) {
  // DOM APIs only — server-derived names are textContent, never innerHTML
  // (2026 review: crafted titles could inject markup into the popup).
  select.replaceChildren();
  if (!rows.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
    return;
  }
  for (const row of rows) {
    const option = document.createElement("option");
    option.value = row.value;
    option.textContent = row.label;
    select.append(option);
  }
}

async function loadLists(configured, updateConnection = true) {
  const cards = await send("dreamedia:cards");
  if (cards.ok) {
    fillOptions(
      $("card"),
      (cards.data.cards || []).map((c) => ({
        value: String(c.id),
        label: `${c.name || "Untitled"} (${c.done}/${c.total})`,
      })),
      "No custom playlists in Todo",
    );
  } else {
    fillOptions($("card"), [], configured ? "Couldn’t load playlists" : "Connect DreaMedia to load playlists");
  }
  const categoryResult = await send("dreamedia:categories");
  if (categoryResult.ok) {
    categories = categoryResult.data.categories || [];
    fillDatalist("domainSuggestions", categories.map((row) => row.name));
  } else {
    categories = [];
    fillDatalist("domainSuggestions", []);
  }
  updateCategorySuggestions();
}
async function initializePopup() {
  let configured = false;
  try {
    configured = await loadConfiguration();
    if (configured) await send("dreamedia:refreshDomains");
  } catch (error) {
    status("configStatus", `Couldn’t read settings: ${error.message}`, "err");
    setConnection("err", "Settings unavailable");
    configured = false;
  }
  try {
    await checkSite();
  } catch (error) {
    $("siteHost").textContent = "Site unavailable";
    status("siteStatus", error.message, "err");
  }
  await loadLists(configured);
  if (configured) await resumeImportJobs();
  await refreshTrackingStatus();
  setInterval(() => void refreshTrackingStatus(), 1000);
}
void initializePopup();
