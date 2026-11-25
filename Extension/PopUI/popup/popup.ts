/**
 * DreaMedia PopUI — Popup Page
 * Main popup UI: connection settings, site enable/disable, YouTube subscription
 * management, anime tracking, and playlist add.
 * No `any` type permitted.
 */

import type { SubscriptionOptions } from "../../Media/Yt/Config/Model/types";
import type { DomainRow } from "../../Media/Yt/Config/Model/types";
import type { CategoryRow } from "../../Media/Yt/Config/Model/types";

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

function status(id: string, text: string, cls = ""): void {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function currentTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

// ── Tracking state ──────────────────────────────────────────────────

let trackingRequestInFlight = false;
let animeTrackingSite = false;
let animeTrackingEnabled = false;

function formatClock(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—:—";
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

interface TrackingData {
  bound: boolean;
  entryId: number | null;
  title: string;
  season: number | null;
  episode: number | null;
  episodeSource: string;
  positionSeconds: number | null;
  durationSeconds: number | null;
  playing: boolean;
  state: string;
  pageTitle: string;
  urlEpisode: number | null;
  urlSeason: number | null;
  urlEpisodeSource: string;
  url: string;
  sampledAt: number;
}

function renderTracking(data: TrackingData | null): void {
  const card = $("trackingCard");
  const title = $("trackingTitle");
  const detail = $("trackingDetail");
  const clock = $("trackingTime");
  if (!data) {
    card.dataset.state = "idle";
    title.textContent = !animeTrackingEnabled
      ? "Anime tracking paused"
      : "Starting anime tracking…";
    detail.textContent = !animeTrackingEnabled
      ? "Enable this domain to match the page and video"
      : "Matching the page title and locating the video";
    clock.textContent = "—:—";
    return;
  }
  if (!data.bound || !data.entryId) {
    card.dataset.state = "idle";
    const pageTitle = String(data.pageTitle ?? "").trim();
    title.textContent =
      data.state === "matching"
        ? pageTitle || "Matching page title…"
        : "No tracked anime match";
    detail.textContent =
      data.state === "matching"
        ? data.urlEpisode != null
          ? `Matching tracked titles · URL suggests episode ${data.urlEpisode}`
          : "Matching this page title against tracked anime"
        : data.urlEpisode != null
          ? `Page: ${pageTitle || "unknown title"} · URL suggests episode ${data.urlEpisode}`
          : `Page: ${pageTitle || "unknown title"}`;
    clock.textContent = "—:—";
    return;
  }

  const animeTitle = data.title || `Anime ${data.entryId}`;
  const season = Number(data.season) > 0 ? `S${data.season} · ` : "";
  const episode = data.episode != null ? `Episode ${data.episode}` : "Episode unknown";
  const sources: Record<string, string> = {
    url: "URL",
    title: "title",
    cursor: "saved cursor",
    ended: "ended +1",
  };
  const source = sources[data.episodeSource] ?? data.episodeSource ?? "estimate";
  const stateText: Record<string, string> = {
    playing: "Tracking",
    paused: "Paused",
    waiting: "Waiting for video",
    ended:
      data.episodeSource === "ended" ? "Next episode estimate" : "Episode ended",
    unmatched: "Not matched",
  };
  const stateLabel = stateText[data.state] || "Tracking";
  card.dataset.state =
    data.state === "playing" || data.state === "paused" || data.state === "ended"
      ? data.state
      : "idle";
  title.textContent = animeTitle;
  detail.textContent = `${stateLabel} · ${season}${episode} · ${source}`;
  const current = formatClock(data.positionSeconds ?? 0);
  const total = formatClock(data.durationSeconds ?? 0);
  clock.textContent =
    data.durationSeconds != null && total !== "—:—"
      ? `${current} / ${total}`
      : current;
}

async function refreshTrackingStatus(): Promise<void> {
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
    if (response.ok && response.data) {
      renderTracking(response.data as TrackingData);
    } else {
      renderTracking(null);
    }
  } catch {
    renderTracking(null);
  } finally {
    trackingRequestInFlight = false;
  }
}

// ── Connection state ────────────────────────────────────────────────

function setConnection(state: string, text: string): void {
  $("connection").dataset.state = state;
  $("connectionText").textContent = text;
}

interface ConnectionStateData {
  status: string;
  reason: string;
}

function applyConnectionState(data: ConnectionStateData): void {
  const labels: Record<string, [string, string]> = {
    idle: [
      "idle",
      data.reason === "No enabled site open" ? "Open an enabled site" : "Not connected",
    ],
    connected: ["ok", "Connected (WebSocket)"],
    connecting: [
      "loading",
      data.reason === "Reconnecting" ? "Reconnecting…" : "Connecting…",
    ],
    disconnected: ["err", "Disconnected"],
  };
  const labelEntry = (labels[data.status] ?? labels.disconnected) as [string, string];
  const [state, text] = labelEntry;
  setConnection(state, text);
  $("connection").title = data.reason ?? "";
}

async function syncConnectionStatus(): Promise<void> {
  const response = await send("dreamedia:connectionStatus");
  if (response.ok && response.data) {
    applyConnectionState(response.data as ConnectionStateData);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "dreamedia:connectionStatus") {
    applyConnectionState(message as ConnectionStateData);
  }
});

function action(
  buttonId: string,
  statusId: string,
  run: () => Promise<void>
): void {
  const button = $(buttonId) as HTMLButtonElement;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      status(statusId, `Failed: ${(error as Error).message}`, "err");
    } finally {
      button.disabled = false;
    }
  });
}

// ── Tab / page detection ────────────────────────────────────────────

const tabEls = Array.from(
  document.querySelectorAll<HTMLElement>('[role="tab"]')
);
let chooseInitialTab = true;
let page: {
  kind: string;
  playlist: boolean;
  subscriptionChannels: boolean;
} = { kind: "none", playlist: false, subscriptionChannels: false };
let currentUrl = "";

function describePage(raw: string): {
  kind: string;
  playlist: boolean;
  subscriptionChannels: boolean;
} {
  try {
    const url = new URL(raw);
    const youtube = /(^|\.)youtube\.com$/i.test(url.hostname);
    const shortLink = url.hostname === "youtu.be";
    const subscriptionChannels =
      youtube && url.pathname === "/feed/channels";
    const video =
      (shortLink && url.pathname.length > 1) ||
      (youtube &&
        (url.pathname === "/watch" && url.searchParams.has("v") ||
          /^\/(?:shorts|live|embed)\/[^/]+/.test(url.pathname)));
    const channel =
      youtube && /^\/(@[^/]+|channel\/UC[^/]+)/.test(url.pathname);
    return {
      kind: video
        ? "video"
        : channel
          ? "channel"
          : youtube || shortLink
            ? "youtube"
            : "other",
      playlist: (youtube || shortLink) && Boolean(url.searchParams.get("list")),
      subscriptionChannels,
    };
  } catch {
    return { kind: "none", playlist: false, subscriptionChannels: false };
  }
}

function selectTab(selected: HTMLElement): void {
  for (const tab of tabEls) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    const controls = tab.getAttribute("aria-controls");
    if (controls) {
      $(controls).hidden = !active;
    }
  }
}

for (const [index, tab] of tabEls.entries()) {
  tab.addEventListener("click", () => {
    chooseInitialTab = false;
    selectTab(tab);
  });
  tab.addEventListener("keydown", (event: KeyboardEvent) => {
    let next = 0;
    if (event.key === "ArrowRight") next = (index + 1) % tabEls.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + tabEls.length) % tabEls.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabEls.length - 1;
    else return;
    event.preventDefault();
    chooseInitialTab = false;
    selectTab(tabEls[next] as HTMLElement);
    (tabEls[next] as HTMLElement).focus();
  });
}

function showSettings(show: boolean, focus = true): void {
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

// ── Configuration & site ────────────────────────────────────────────

let categories: CategoryRow[] = [];
let lastCategoryDomainValue = "";

async function loadConfiguration(): Promise<boolean> {
  let configured = false;
  const cfg = await chrome.storage.local.get(["backendUrl", "token"]);
  if (cfg.backendUrl) ($("backendUrl") as HTMLInputElement).value =
    String(cfg.backendUrl);
  if (cfg.token) ($("token") as HTMLInputElement).value = String(cfg.token);
  configured = Boolean(cfg.token);
  if (!configured) {
    setConnection("idle", "Not connected");
    showSettings(true, false);
  } else {
    await syncConnectionStatus();
  }
  return configured;
}

action(
  "saveConfig",
  "configStatus",
  async (): Promise<void> => {
    const backendUrl = ($("backendUrl") as HTMLInputElement).value.trim();
    const token = ($("token") as HTMLInputElement).value.trim();
    let parsedBackendUrl: URL;
    try {
      parsedBackendUrl = new URL(backendUrl);
    } catch {
      throw new Error("Enter a valid HTTP or HTTPS backend URL.");
    }
    if (
      parsedBackendUrl.protocol !== "http:" &&
      parsedBackendUrl.protocol !== "https:"
    ) {
      throw new Error("Enter a valid HTTP or HTTPS backend URL.");
    }
    if (!token) throw new Error("Enter the extension token.");
    await chrome.storage.local.set({ backendUrl, token, domains: null });
    status("configStatus", "Connecting by WebSocket…");
    const connection = await send("dreamedia:connect");
    if (!connection.ok) {
      throw new Error(connection.error ?? "WebSocket authentication failed.");
    }
    applyConnectionState(connection.data as ConnectionStateData);
    if (
      connection.data &&
      (connection.data as ConnectionStateData).status === "idle" &&
      (connection.data as ConnectionStateData).reason === "No enabled site open"
    ) {
      status(
        "configStatus",
        "Saved. Open YouTube or another enabled site to connect.",
        "ok"
      );
      showSettings(false);
      return;
    }
    status("configStatus", "WebSocket connected.", "ok");
    const refreshed = await send("dreamedia:refreshDomains");
    if (!refreshed.ok) {
      throw new Error(refreshed.error ?? "Background refresh failed");
    }
    await loadLists(true, false);
    await checkSite();
    await syncConnectionStatus();
    showSettings(false);
  }
);

async function checkSite(): Promise<void> {
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
  const host = (r.data as { host?: string })?.host ?? new URL(tab.url).hostname;
  $("siteHost").textContent = host;
  const registered = (r.data as { registered?: DomainRow | null }).registered;
  const videoSite =
    registered?.media === "yt" ||
    ["youtube", "video", "channel"].includes(page.kind);
  $("siteIcon").querySelector("use")?.setAttribute(
    "href",
    videoSite ? "#video" : "#globe"
  );
  animeTrackingSite = registered?.media === "ani";
  animeTrackingEnabled = animeTrackingSite && registered?.enabled !== false;
  $("trackingCard").hidden = !animeTrackingSite;
  $("pageActions").hidden = animeTrackingSite;
  $("subscribePanel").hidden = animeTrackingSite;
  $("playlistPanel").hidden = animeTrackingSite;
  if (chooseInitialTab && !animeTrackingSite) {
    chooseInitialTab = false;
    const initialTab = page.kind === "video" ? "playlistTab" : "subscribeTab";
    selectTab($(initialTab));
    if (
      initialTab === "subscribeTab" &&
      page.kind === "youtube" &&
      page.playlist
    ) {
      ($("kind") as HTMLSelectElement).value = "playlist";
    }
  }
  showSubscriptionFields();
  if (!(r as { ok: boolean }).ok) {
    badge.hidden = true;
    $("siteEnable").hidden = true;
    status(
      "siteStatus",
      `Couldn’t check this site: ${(r as { error?: string }).error}`,
      "err"
    );
    return;
  }
  const listed = Boolean(registered);
  const enabled = listed && registered?.enabled !== false;
  badge.hidden = false;
  badge.textContent = enabled ? "Enabled" : listed ? "Paused" : "Not enabled";
  badge.classList.toggle("enabled", enabled);
  const media = registered?.media === "ani" ? "Anime" : "YouTube";
  badge.title = listed
    ? `${media} · ${enabled ? "Enabled" : "Paused in DreaMedia"}`
    : "";
  $("siteEnable").hidden = listed;
  $("siteMediaWrap").hidden = listed;
  $("enableSite").textContent = "Enable site";
  if (listed && !enabled) {
    status("siteStatus", "Resume this site in DreaMedia → Ext → Sites.");
  } else if ($("siteStatus").classList.contains("err")) {
    status("siteStatus", "");
  }
}

action(
  "enableSite",
  "siteStatus",
  async (): Promise<void> => {
    const pageUrl = currentUrl;
    if (!pageUrl) return status("siteStatus", "Open a web page first", "err");
    status("siteStatus", "Adding site to DreaMedia…");
    const r = await send("dreamedia:addDomain", {
      domain: pageUrl,
      media: ($("siteMedia") as HTMLSelectElement).value,
    });
    status(
      "siteStatus",
      (r as { ok: boolean }).ok
        ? "Site added. Anime matching and video tracking start automatically."
        : `Failed: ${(r as { error?: string }).error}`,
      (r as { ok: boolean }).ok ? "ok" : "err"
    );
    if ((r as { ok: boolean }).ok) {
      await checkSite();
      $("siteHost").focus();
    }
  }
);

// ── Conditional fields ──────────────────────────────────────────────

function showSubscriptionFields(): void {
  const kind = ($("kind") as HTMLSelectElement).value;
  $("wordsField").hidden = kind !== "wordscan";
  $("rankField").hidden = kind !== "random";
  $("withholdField").hidden = kind !== "withhold";
}

$("kind").addEventListener("change", showSubscriptionFields);
showSubscriptionFields();

function fillDatalist(id: string, values: string[]): void {
  const list = $(id) as HTMLDataListElement;
  list.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    list.append(option);
  }
}

function updateCategorySuggestions(): void {
  const domainName = ($("domain") as HTMLInputElement).value.trim();
  if (domainName.toLowerCase() !== lastCategoryDomainValue.toLowerCase()) {
    ($("subdomain") as HTMLInputElement).value = "";
    lastCategoryDomainValue = domainName;
  }
  const domain = categories.find(
    (row) => row.name.toLowerCase() === domainName.toLowerCase()
  );
  const subdomainInput = $("subdomain") as HTMLInputElement;
  subdomainInput.disabled = !domainName;
  subdomainInput.placeholder = domainName
    ? "Existing or new subdomain"
    : "Choose a domain first";
  fillDatalist(
    "subdomainSuggestions",
    (domain?.subdomains ?? []).map((row) => row.name)
  );
}

$("domain").addEventListener("input", updateCategorySuggestions);

// ── Subscription import state ───────────────────────────────────────

let scannedSubscriptions: { url: string; name: string }[] = [];
let subscriptionScanComplete = false;
const activeImportJobs = new Map<string, { message: string }>();
const failedImportJobs = new Set<string>();
const recentImportJobIds = new Set<string>();
const pollingImportJobs = new Set<string>();
const hiddenImportJobIds = new Set<string>();
const importHistoryWriteFailures = new Set<string>();
const FINISHED_IMPORT_STATUSES = new Set(["completed", "partial"]);
let importJobsStorageWrite = Promise.resolve();
let scanStatusMessage = "";
let scanStatusClass = "";
let lastImportStatus = "";
let lastImportStatusClass = "";

function setAddSourceLabel(text: string): void {
  $("subscribeLabel").textContent = text;
}

function renderImportStatus(): void {
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
  $("importTableMeta").textContent = activeImportJobs.size
    ? `${activeImportJobs.size} active`
    : failedImportJobs.size
      ? `${failedImportJobs.size} with failures`
      : "Recent batches";
}

function setImportScanStatus(text: string, cls = ""): void {
  scanStatusMessage = text;
  scanStatusClass = cls;
  renderImportStatus();
}

function setImportJobStatus(text: string, cls = ""): void {
  lastImportStatus = text;
  lastImportStatusClass = cls;
  renderImportStatus();
}

async function persistImportJobId(jobId: string, promoteRecent = false): Promise<void> {
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

async function isImportJobHidden(jobId: string): Promise<boolean> {
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
  importHistoryWriteFailures.delete(jobId);
}

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

function syncFailedImportJob(
  jobId: string,
  job: { status: string; failed: number; failedItems?: unknown[] }
): boolean {
  if (!FINISHED_IMPORT_STATUSES.has(job.status)) return false;
  const wasFailed = failedImportJobs.has(jobId);
  if (job.failed > 0) failedImportJobs.add(jobId);
  else failedImportJobs.delete(jobId);
  return wasFailed !== failedImportJobs.has(jobId);
}

$("openImportTable").addEventListener("click", () => {
  chrome.tabs.create(
    { url: chrome.runtime.getURL("imports.html") },
    (tab) => {
      if (tab?.id != null) {
        chrome.storage.local.set({ importTableTabId: tab.id });
      }
    }
  );
});

$("openScanTable").addEventListener("click", () => {
  chrome.tabs.create(
    { url: chrome.runtime.getURL("scan-table.html") },
    (tab) => {
      if (tab?.id != null) {
        chrome.storage.local.set({ importTableTabId: tab.id });
      }
    }
  );
});

async function trackImportJob(jobId: string, requested: number): Promise<void> {
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

async function startYoutubeImport(
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

function selectedSourceOptions(forBulk = false): SubscriptionOptions {
  const kind = ($("kind") as HTMLSelectElement).value;
  if (forBulk && kind === "playlist") {
    throw new Error("Choose a channel mode, not Playlist, for source batches.");
  }
  const domain = ($("domain") as HTMLInputElement).value.trim();
  const subdomain = ($("subdomain") as HTMLInputElement).value.trim();
  if (Boolean(domain) !== Boolean(subdomain)) {
    throw new Error(
      "Choose both a domain and subdomain, or leave both empty."
    );
  }
  return {
    kind,
    words:
      kind === "wordscan"
        ? ($("words") as HTMLInputElement).value
            .split(",")
            .map((word) => word.trim())
            .filter(Boolean)
        : null,
    rank: kind === "random" ? ($("rank") as HTMLSelectElement).value : null,
    withhold:
      kind === "withhold"
        ? Math.max(1, Math.round(Number(($("withhold") as HTMLInputElement).value) || 2))
        : null,
    domain: domain || null,
    subdomain: subdomain || null,
  };
}

function renderSubscriptionPreview(): void {
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

async function pollImportJob(jobId: string): Promise<void> {
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

async function refreshFailedImportJob(jobId: string): Promise<void> {
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
    if (syncFailedImportJob(jobId, job as { status: string; failed: number })) {
      await persistImportJobId(jobId);
    }
  }
}

async function resumeImportJobs(): Promise<void> {
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
  renderImportStatus();
  for (const jobId of jobIds) {
    if (typeof jobId === "string") void pollImportJob(jobId);
  }
}

// ── Subscribe actions ───────────────────────────────────────────────

action(
  "scanSubscriptions",
  "importStatus",
  async (): Promise<void> => {
    scannedSubscriptions = [];
    subscriptionScanComplete = false;
    setAddSourceLabel("Add source");
    $("importPreview").hidden = true;
    const tab = await currentTab();
    if (!tab?.id) {
      setImportScanStatus(
        "Open YouTube's channel subscriptions page first.",
        "err"
      );
      return;
    }
    setImportScanStatus("Scanning the page and loading more channels…");
    const response = await send("dreamedia:scanYoutubeSubscriptions", {
      tabId: tab.id,
    });
    if (!response.ok) {
      setImportScanStatus(response.error ?? "Subscription scan failed.", "err");
      return;
    }
    scannedSubscriptions = Array.isArray(
      (response as { data?: { channels?: unknown } }).data?.channels
    )
      ? ((response as { data: { channels: { url: string; name: string }[] } })
          .data.channels as { url: string; name: string }[])
      : [];
    subscriptionScanComplete =
      (response as { data?: { complete?: boolean } }).data?.complete === true;
    const scanChannels = scannedSubscriptions.map((ch) => ({
      url: ch.url,
      name: ch.name,
      status: "pending",
      result: "Waiting to be added",
      scannedAt: Date.now(),
    }));
    await chrome.storage.local.set({ youtubeScanChannels: scanChannels });
    const scanButton = $("openScanTable");
    scanButton.hidden = scanChannels.length === 0;
    $("scanTableMeta").textContent = `${scanChannels.length} scanned`;
    renderSubscriptionPreview();
    if (!scannedSubscriptions.length) {
      setImportScanStatus(
        "No channel links found. Check that this is the channel subscriptions page and you are signed in.",
        "err"
      );
      return;
    }
    if (subscriptionScanComplete) {
      const count = scannedSubscriptions.length;
      setAddSourceLabel(`Add ${count} ${count === 1 ? "source" : "sources"}`);
      setImportScanStatus(
        `${scannedSubscriptions.length} unique channel(s) found. Review the preview, then choose Add sources.`,
        "ok"
      );
    } else {
      setImportScanStatus(
        `Found ${scannedSubscriptions.length}, but the page did not reach a stable end. Scroll through the page and scan again before adding sources.`,
        "err"
      );
    }
  });

action(
  "subscribe",
  "subStatus",
  async (): Promise<void> => {
    if (page.subscriptionChannels && !subscriptionScanComplete) {
      throw new Error(
        "Scan the complete channel list first; Add Source will add each scanned channel."
      );
    }
    if (subscriptionScanComplete) {
      if (!scannedSubscriptions.length) {
        throw new Error("Scan the channel list before adding sources.");
      }
      const options = selectedSourceOptions(true);
      const count = scannedSubscriptions.length;
      const sourcePayload = {
        sources: scannedSubscriptions.map((channel) => ({ link: channel.url })),
      };
      await startYoutubeImport(sourcePayload, options, count);
      scannedSubscriptions = [];
      subscriptionScanComplete = false;
      renderSubscriptionPreview();
      setAddSourceLabel("Add source");
      return;
    }
    const tab = await currentTab();
    if (!tab?.url) return status("subStatus", "Open a YouTube page first", "err");
    const options = selectedSourceOptions();
    if (options.kind !== "playlist") {
      await startYoutubeImport(
        { sources: [{ link: tab.url }] },
        options,
        1
      );
      status("subStatus", "Channel import queued.", "ok");
      return;
    }
    const body = { ...options, link: tab.url };
    status("subStatus", "Subscribing…");
    const r = await send("dreamedia:subscribe", { body });
    const subscribed = (r as { ok: boolean }).ok && (r as { data?: { ok?: boolean } }).data?.ok;
    status(
      "subStatus",
      subscribed
        ? "Source added"
        : `Couldn’t add source: ${(r as { error?: string }).error ?? (r as { data?: { error?: string } }).data?.error ?? "Unknown error"}`,
      subscribed ? "ok" : "err"
    );
  }
);

// ── Playlist add ────────────────────────────────────────────────────

action(
  "addVideo",
  "cardStatus",
  async (): Promise<void> => {
    const tab = await currentTab();
    if (!tab?.url) return status("cardStatus", "Open a video page first", "err");
    const cardId = ($("card") as HTMLSelectElement).value;
    if (!cardId) return status("cardStatus", "Pick a playlist first", "err");
    status("cardStatus", "Adding video…");
    const r = await send("dreamedia:addItem", {
      cardId: Number(cardId),
      links: [tab.url],
    });
    const added =
      (r as { ok: boolean }).ok &&
      (((r as { data?: { added?: number } }).data?.added ?? 0) > 0);
    const duplicate =
      (r as { ok: boolean }).ok &&
      (r as { data?: { added?: number; requested?: number; errors?: string[] } }).data &&
      (r as { data?: { added?: number; requested?: number; errors?: string[] } }).data!.added === 0 &&
      (r as { data?: { added?: number; requested?: number; errors?: string[] } }).data!.requested! > 0 &&
      !(r as { data?: { errors?: string[] } }).data?.errors?.length;
    const reason =
      (r as { data?: { errors?: string[] } }).data?.errors?.[0]?.replace(
        `${tab.url}: `,
        ""
      ) || (r as { error?: string }).error;
    status(
      "cardStatus",
      added
        ? "Video added"
        : duplicate
          ? "Already in this playlist"
          : reason || "No video was added",
      added || duplicate ? "ok" : "err"
    );
  }
);

// ── Lists ───────────────────────────────────────────────────────────

function fillOptions(
  select: HTMLSelectElement,
  rows: { value: string; label: string }[],
  emptyLabel: string
): void {
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

async function loadLists(
  configured: boolean,
  _updateConnection = true
): Promise<void> {
  const cards = await send("dreamedia:cards");
  if ((cards as { ok: boolean }).ok) {
    fillOptions(
      $("card") as HTMLSelectElement,
      (((cards as { data: { cards: unknown[] } }).data.cards as unknown[]) ?? []).map(
        (c) => ({
          value: String((c as { id?: number }).id ?? 0),
          label: `${(c as { name?: string }).name ?? "Untitled"} (${(c as { done?: number }).done ?? 0}/${(c as { total?: number }).total ?? 0})`,
        })
      ),
      "No custom playlists in Todo"
    );
  } else {
    fillOptions(
      $("card") as HTMLSelectElement,
      [],
      configured
        ? "Couldn’t load playlists"
        : "Connect DreaMedia to load playlists"
    );
  }
  const categoryResult = await send("dreamedia:categories");
  if ((categoryResult as { ok: boolean }).ok) {
    categories = ((categoryResult as { data: { categories: CategoryRow[] } }).data
      .categories as CategoryRow[]) ?? [];
    fillDatalist(
      "domainSuggestions",
      categories.map((row) => row.name)
    );
  } else {
    categories = [];
    fillDatalist("domainSuggestions", []);
  }
  updateCategorySuggestions();
}

async function initializePopup(): Promise<void> {
  let configured = false;
  try {
    configured = await loadConfiguration();
    if (configured) await send("dreamedia:refreshDomains");
  } catch (error) {
    status("configStatus", `Couldn’t read settings: ${(error as Error).message}`, "err");
    setConnection("err", "Settings unavailable");
    configured = false;
  }
  try {
    await checkSite();
  } catch (error) {
    $("siteHost").textContent = "Site unavailable";
    status("siteStatus", (error as Error).message, "err");
  }
  await loadLists(configured);
  if (configured) await resumeImportJobs();
  // Restore scan table button visibility from stored channels
  const stored = await chrome.storage.local.get(["youtubeScanChannels"]);
  const savedChannels = Array.isArray(stored.youtubeScanChannels)
    ? stored.youtubeScanChannels
    : [];
  if (savedChannels.length > 0) {
    $("openScanTable").hidden = false;
    $("scanTableMeta").textContent = `${savedChannels.length} scanned`;
  }
  await refreshTrackingStatus();
  setInterval(() => void refreshTrackingStatus(), 1000);
}

void initializePopup();
