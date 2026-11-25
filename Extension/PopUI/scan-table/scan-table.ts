/**
 * DreaMedia PopUI — Scan Table Page
 *
 * Nushell-like table of channels captured by subscription scans.
 * Loads scan results from chrome.storage.local (written by the popup
 * after a scanYoutubeSubscriptions call) and renders them as rows with
 * status, URL, and result.
 * No `any` type permitted.
 */

export {};

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element: #${id}`);
  return el;
};

interface ScanChannel {
  url: string;
  name: string;
  status: "added" | "skipped" | "failed" | "pending";
  result: string;
  scannedAt: number;
}

const SCAN_CHANNELS_KEY = "youtubeScanChannels";
const SCAN_TAB_KEY = "scanTableTabId";

let channels: ScanChannel[] = [];
let statusFilter = "all";
let hasSavedScan = false;

function filterChannels(): ScanChannel[] {
  if (statusFilter === "all") return channels;
  return channels.filter((c) => c.status === statusFilter);
}

function statusLabel(status: string): string {
  return ({
    added: "Added",
    skipped: "Already present",
    failed: "Failed",
    pending: "Pending",
  } as Record<string, string>)[status] ?? status;
}

function statusClass(status: string): string {
  return `state-${status}`;
}

function renderRows(filtered: ScanChannel[]): void {
  const body = $("itemRows");
  const noRows = $("noRows");
  body.replaceChildren();
  if (!filtered.length) {
    noRows.hidden = false;
    return;
  }
  noRows.hidden = true;
  for (const ch of filtered) {
    const row = document.createElement("tr");
    const number = document.createElement("td");
    number.className = "row-number";
    const idx = filtered.indexOf(ch);
    number.textContent = String(idx + 1);

    const channelCell = document.createElement("td");
    const name = document.createElement("div");
    name.textContent = ch.name || ch.url.split("/").filter(Boolean).pop() || "Unknown";
    const url = document.createElement("div");
    url.className = "channel-link";
    url.textContent = ch.url;
    channelCell.append(name, url);

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `row-status ${statusClass(ch.status)}`;
    const mark = document.createElement("span");
    mark.className = "state-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = ch.status === "added" ? "✓" : ch.status === "failed" ? "!" : "·";
    const label = document.createElement("span");
    label.textContent = statusLabel(ch.status);
    badge.append(mark, label);
    statusCell.append(badge);

    const resultCell = document.createElement("td");
    resultCell.className = "row-result" + (ch.status === "failed" ? " error" : "");
    resultCell.textContent = ch.result;

    row.append(number, channelCell, statusCell, resultCell);
    body.append(row);
  }
}

function renderSummary(filtered: ScanChannel[]): void {
  const added = channels.filter((c) => c.status === "added").length;
  const skipped = channels.filter((c) => c.status === "skipped").length;
  const failed = channels.filter((c) => c.status === "failed").length;
  const working = channels.filter((c) => c.status === "pending").length;

  $("batchStatus").textContent = statusFilter === "all" ? `${channels.length} channel(s)` : `${filtered.length} channel(s)`;
  $("batchProgress").textContent = `${added + skipped + failed + working} scanned`;

  $("doneCount").className = "done-count";
  $("doneCount").textContent = `${added} added · ${skipped} already present`;
  $("workingCount").textContent = `${working} pending`;
  $("failedCount").className = failed ? "failed-count" : "";
  $("failedCount").textContent = `${failed} failed`;
}

function render(): void {
  const filtered = filterChannels();
  renderRows(filtered);
  renderSummary(filtered);
}

async function loadChannels(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([SCAN_CHANNELS_KEY]);
    const raw = stored[SCAN_CHANNELS_KEY];
    hasSavedScan = Array.isArray(raw);
    if (hasSavedScan) {
      channels = (raw as unknown[]).filter(
        (c): c is ScanChannel =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as Record<string, unknown>).url === "string" &&
          typeof (c as Record<string, unknown>).name === "string",
      );
    } else {
      channels = [];
    }
    render();
    $("scanView").hidden = !hasSavedScan;
    $("pageMessage").hidden = hasSavedScan;
    if (!hasSavedScan) {
      $("pageMessage").textContent = "No saved scan results. Run a subscription scan from the DreaMedia popup.";
    }
  } catch {
    hasSavedScan = false;
    channels = [];
    $("scanView").hidden = true;
    $("pageMessage").hidden = false;
    $("pageMessage").className = "page-message error";
    $("pageMessage").textContent = "Could not load scan results. Refresh the page and try again.";
  }
}

async function deleteScan(): Promise<void> {
  if (!hasSavedScan) return;
  if (!window.confirm("Delete this scan preview? Sources already added to DreaMedia will remain.")) return;
  await chrome.storage.local.remove(SCAN_CHANNELS_KEY);
  channels = [];
  hasSavedScan = false;
  render();
  $("pageMessage").textContent = "Scan deleted. Run a new subscription scan from the DreaMedia popup.";
  $("pageMessage").hidden = false;
  $("scanView").hidden = true;
}

$("closePage").addEventListener("click", () => {
  chrome.tabs.getCurrent((tab) => {
    const tabId = tab?.id;
    if (tabId == null) return;
    chrome.storage.local.get(SCAN_TAB_KEY, (result) => {
      if (result[SCAN_TAB_KEY] === tabId) chrome.storage.local.remove(SCAN_TAB_KEY);
    });
    chrome.tabs.remove(tabId);
  });
});

$("refreshScan").addEventListener("click", () => {
  void loadChannels();
});

$("deleteScan").addEventListener("click", () => void deleteScan());

$("statusFilter").addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  statusFilter = (target.value as "all" | "added" | "skipped" | "failed" | "pending") ?? "all";
  render();
});

void loadChannels();
