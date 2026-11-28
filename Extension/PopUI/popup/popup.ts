/**
 * DreaMedia PopUI — Popup Page (orchestrator)
 * Main popup UI: connection settings, site enable/disable, YouTube subscription
 * management, anime tracking, and playlist add.
 * No `any` type permitted.
 */

import type { SubscriptionOptions } from "../../Media/Yt/Config/Model/types";
import type { DomainRow } from "../../Media/Yt/Config/Model/types";
import type { CategoryRow } from "../../Media/Yt/Config/Model/types";

import {
  $, send, status, currentTab, formatClock, action, shared,
  showSubscriptionFields, fillDatalist,
} from "./shared";
import {
  renderTracking, refreshTrackingStatus,
} from "./tracking";
import {
  setConnection, applyConnectionState, syncConnectionStatus, listenConnectionChanges,
  ConnectionStateData,
} from "./connection";
import {
  setAddSourceLabel, renderImportStatus, setImportScanStatus, setImportJobStatus,
  persistImportJobId, isImportJobHidden, isFullySuccessfulImport,
  deleteImportJobHistory, deleteFinishedImportsFromPopup,
  listenImportHistoryChanges, setupImportTableButtons,
  syncFailedImportJob, trackImportJob, startYoutubeImport,
  renderSubscriptionPreview, pollImportJob,
  refreshFailedImportJob, refreshRecentImportJob, resumeImportJobs,
  getScannedSubscriptions, setScannedSubscriptions,
  getSubscriptionScanComplete, setSubscriptionScanComplete,
  getActiveImportJobCount, getFailedImportJobCount, getRecentImportJobCount,
} from "./import-state";

// ── Tracking state ──────────────────────────────────────────────────

let trackingRequestInFlight = false;

// ── Tab / page detection ────────────────────────────────────────────

const tabEls = Array.from(
  document.querySelectorAll<HTMLElement>('[role="tab"]')
);
let chooseInitialTab = true;

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
    shared.currentUrl = "";
    $("siteHost").textContent = "No web page open";
    $("siteEnable").hidden = true;
    badge.hidden = true;
    showSubscriptionFields();
    return;
  }
  shared.currentUrl = tab.url;
  shared.page = describePage(tab.url);
  const r = await send("dreamedia:domainStatus", { url: tab.url });
  const host = (r.data as { host?: string })?.host ?? new URL(tab.url).hostname;
  $("siteHost").textContent = host;
  const registered = (r.data as { registered?: DomainRow | null }).registered;
  const videoSite =
    registered?.media === "yt" ||
    ["youtube", "video", "channel"].includes(shared.page.kind);
  $("siteIcon").querySelector("use")?.setAttribute(
    "href",
    videoSite ? "#video" : "#globe"
  );
  shared.animeTrackingSite = registered?.media === "ani";
  shared.animeTrackingEnabled = shared.animeTrackingSite && registered?.enabled !== false;
  $("trackingCard").hidden = !shared.animeTrackingSite;
  $("pageActions").hidden = shared.animeTrackingSite;
  $("subscribePanel").hidden = shared.animeTrackingSite;
  $("playlistPanel").hidden = shared.animeTrackingSite;
  if (chooseInitialTab && !shared.animeTrackingSite) {
    chooseInitialTab = false;
    const initialTab = shared.page.kind === "video" ? "playlistTab" : "subscribeTab";
    selectTab($(initialTab));
    if (
      initialTab === "subscribeTab" &&
      shared.page.kind === "youtube" &&
      shared.page.playlist
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
    const pageUrl = shared.currentUrl;
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

$("kind").addEventListener("change", showSubscriptionFields);
showSubscriptionFields();

function updateCategorySuggestions(): void {
  const domainName = ($("domain") as HTMLInputElement).value.trim();
  if (domainName.toLowerCase() !== lastCategoryDomainValue.toLowerCase()) {
    ($("subdomain") as HTMLInputElement).value = "";
    lastCategoryDomainValue = domainName;
  }
  const domain = shared.categories.find(
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

// ── Subscribe actions ───────────────────────────────────────────────

action(
  "scanSubscriptions",
  "importStatus",
  async (): Promise<void> => {
    setScannedSubscriptions([]);
    setSubscriptionScanComplete(false);
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
    const scannedSubscriptions = Array.isArray(
      (response as { data?: { channels?: unknown } }).data?.channels
    )
      ? ((response as { data: { channels: { url: string; name: string }[] } })
          .data.channels as { url: string; name: string }[])
      : [];
    setScannedSubscriptions(scannedSubscriptions);
    setSubscriptionScanComplete(
      (response as { data?: { complete?: boolean } }).data?.complete === true
    );
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
    if (getSubscriptionScanComplete()) {
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
    if (shared.page.subscriptionChannels && !getSubscriptionScanComplete()) {
      throw new Error(
        "Scan the complete channel list first; Add Source will add each scanned channel."
      );
    }
    if (getSubscriptionScanComplete()) {
      const scannedSubscriptions = getScannedSubscriptions();
      if (!scannedSubscriptions.length) {
        throw new Error("Scan the channel list before adding sources.");
      }
      const options = selectedSourceOptions(true);
      const count = scannedSubscriptions.length;
      const sourcePayload = {
        sources: scannedSubscriptions.map((channel) => ({ link: channel.url })),
      };
      await startYoutubeImport(sourcePayload, options, count);
      setScannedSubscriptions([]);
      setSubscriptionScanComplete(false);
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
    shared.categories = ((categoryResult as { data: { categories: CategoryRow[] } }).data
      .categories as CategoryRow[]) ?? [];
    fillDatalist(
      "domainSuggestions",
      shared.categories.map((row) => row.name)
    );
  } else {
    shared.categories = [];
    fillDatalist("domainSuggestions", []);
  }
  updateCategorySuggestions();
}

// ── Initialize ──────────────────────────────────────────────────────

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
  listenConnectionChanges();
  listenImportHistoryChanges();
  setupImportTableButtons();
  await refreshTrackingStatus(shared.animeTrackingEnabled, shared.animeTrackingSite);
  setInterval(() => void refreshTrackingStatus(shared.animeTrackingEnabled, shared.animeTrackingSite), 1000);
}

void initializePopup();
