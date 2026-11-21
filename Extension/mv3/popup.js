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

function setConnection(state, text) {
  $("connection").dataset.state = state;
  $("connectionText").textContent = text;
}

function applyConnectionState(data) {
  const labels = {
    idle: ["idle", "Not connected"],
    connected: ["ok", "Connected"],
    connecting: ["loading", "Connecting…"],
    disconnected: ["err", data.reason ? `Disconnected: ${data.reason}` : "Disconnected"],
  };
  const [state, text] = labels[data.status] || labels.disconnected;
  setConnection(state, text);
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
let page = { kind: "none", playlist: false };

function describePage(raw) {
  try {
    const url = new URL(raw);
    const youtube = /(^|\.)youtube\.com$/i.test(url.hostname);
    const shortLink = url.hostname === "youtu.be";
    const video = (shortLink && url.pathname.length > 1) || (youtube && (
      (url.pathname === "/watch" && url.searchParams.has("v")) ||
      /^\/(?:shorts|live|embed)\/[^/]+/.test(url.pathname)
    ));
    const channel = youtube && /^\/(?:@[^/]+|channel\/UC[^/]+)/.test(url.pathname);
    return {
      kind: video ? "video" : channel ? "channel" : youtube || shortLink ? "youtube" : "other",
      playlist: (youtube || shortLink) && Boolean(url.searchParams.get("list")),
    };
  } catch {
    return { kind: "none", playlist: false };
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
  await chrome.storage.local.set({ backendUrl: $("backendUrl").value.trim(), token: $("token").value.trim() });
  status("configStatus", "Checking connection…");
  setConnection("loading", "Checking connection…");
  const r = await send("dreamedia:ping");
  status("configStatus", r.ok ? "Connection verified" : `Connection failed: ${r.error}`, r.ok ? "ok" : "err");
  if (r.ok) setConnection("ok", "Connected");
  else setConnection("loading", "Retrying connection…");
  if (r.ok) {
    const refreshed = await send("dreamedia:refreshDomains");
    if (!refreshed.ok) throw new Error(refreshed.error || "Background refresh failed");
    await loadLists(true, false);
    await checkSite();
    await syncConnectionStatus();
    showSettings(false);
  }
});

// ---- this site (ext v2: domain allowlist) ----
async function checkSite() {
  const tab = await currentTab();
  const badge = $("siteBadge");
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    $("siteHost").textContent = "No web page open";
    $("siteEnable").hidden = true;
    badge.hidden = true;
    showSubscriptionFields();
    return;
  }
  page = describePage(tab.url);
  const r = await send("dreamedia:domainStatus", { url: tab.url });
  const host = r.host || new URL(tab.url).hostname;
  $("siteHost").textContent = host;
  const videoSite = r.registered?.media === "yt" || ["youtube", "video", "channel"].includes(page.kind);
  $("siteIcon").querySelector("use").setAttribute("href", videoSite ? "#video" : "#globe");
  if (chooseInitialTab) {
    chooseInitialTab = false;
    const initialTab = r.registered?.media === "ani" || (page.kind === "other" && !videoSite) ? "trackTab"
      : page.kind === "video" ? "playlistTab" : "subscribeTab";
    selectTab($(initialTab));
    if (initialTab === "subscribeTab" && page.kind === "youtube" && page.playlist) $("kind").value = "playlist";
  }
  $("playlistHint").textContent = page.kind === "video"
    ? "Save this video to a custom playlist in Todo."
    : "Open a YouTube video to save it to a custom playlist in Todo.";
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
  if (listed && !enabled) status("siteStatus", "Resume this site in DreaMedia → Ext → Sites.");
  else if ($("siteStatus").classList.contains("err")) status("siteStatus", "");
  $("trackHint").textContent = enabled && r.registered.media === "ani"
    ? "Manually link this tab to an anime you already track."
    : "This site must be enabled as Anime for playback to sync.";
}

action("enableSite", "siteStatus", async () => {
  const tab = await currentTab();
  if (!tab?.url) return status("siteStatus", "Open a web page first", "err");
  status("siteStatus", "Enabling…");
  const r = await send("dreamedia:addDomain", {
    domain: tab.url,
    media: $("siteMedia").value,
  });
  status("siteStatus", r.ok ? "Site added. Reload the tab to activate tracking." : `Failed: ${r.error}`, r.ok ? "ok" : "err");
  if (r.ok) {
    await checkSite();
    $("siteHost").focus();
  }
});
checkSite().catch((error) => {
  $("siteHost").textContent = "Site unavailable";
  status("siteStatus", error.message, "err");
});

// ---- conditional fields ----
function showSubscriptionFields() {
  const kind = $("kind").value;
  $("wordsField").hidden = kind !== "wordscan";
  $("rankField").hidden = kind !== "random";
  $("withholdField").hidden = kind !== "withhold";
  $("sourceHint").textContent = kind === "playlist"
    ? (page.playlist ? "Follow new items in the YouTube playlist linked to this page." : "Open a YouTube playlist or a video within that playlist.")
    : (page.kind === "channel" ? "Follow this channel in your DreaMedia feed." : "Open a YouTube channel page for this notification type.");
}
$("kind").addEventListener("change", showSubscriptionFields);
showSubscriptionFields();

let categories = [];
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
  const domain = categories.find((row) => row.name.toLowerCase() === domainName.toLowerCase());
  const subdomainInput = $("subdomain");
  subdomainInput.disabled = !domainName;
  subdomainInput.placeholder = domainName ? "Existing or new subdomain" : "Choose a domain first";
  fillDatalist("subdomainSuggestions", (domain?.subdomains || []).map((row) => row.name));
}
$("domain").addEventListener("input", updateCategorySuggestions);

// ---- subscribe ----
action("subscribe", "subStatus", async () => {
  const tab = await currentTab();
  if (!tab?.url) return status("subStatus", "Open a YouTube page first", "err");
  const kind = $("kind").value;
  const domain = $("domain").value.trim();
  const subdomain = $("subdomain").value.trim();
  if (Boolean(domain) !== Boolean(subdomain)) {
    return status("subStatus", "Choose both a domain and subdomain, or leave both empty.", "err");
  }
  const body = { kind, link: tab.url };
  if (kind === "wordscan") body.words = $("words").value.split(",").map((w) => w.trim()).filter(Boolean);
  if (kind === "random") body.rank = $("rank").value;
  if (kind === "withhold") body.withhold = Math.max(1, Math.round(Number($("withhold").value) || 2));
  if (domain && subdomain) Object.assign(body, { domain, subdomain });
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
  const added = r.ok && r.data.added > 0;
  const reason = r.data?.errors?.[0]?.replace(`${tab.url}: `, "") || r.error;
  status("cardStatus", added ? "Video added" : reason || "No video was added", added ? "ok" : "err");
});

// ---- anime binding ----
action("bind", "bindStatus", async () => {
  const tab = await currentTab();
  if (!tab?.id) return status("bindStatus", "Open a tab to track first", "err");
  const entryId = Number($("entry").value);
  if (!entryId) return status("bindStatus", "Pick an entry first", "err");
  const binding = { entryId, season: Number($("season").value) || 1, episode: Number($("episode").value) || 1 };
  await (chrome.storage.session || chrome.storage.local).set({ dreamediaBinding: binding });
  const delivered = await chrome.tabs.sendMessage(tab.id, { type: "dreamedia:bind", binding }).then(() => true, () => false);
  status("bindStatus", delivered ? "Binding saved. Progress syncs every 15 seconds during playback." : "Binding saved. Reload an enabled anime tab to start syncing.", "ok");
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
  const entries = await send("dreamedia:aniEntries");
  if (entries.ok) {
    fillOptions(
      $("entry"),
      (entries.data.entries || []).map((e) => ({ value: String(e.id), label: String(e.title ?? "") })),
      "No anime tracked yet",
    );
  } else {
    fillOptions($("entry"), [], configured ? "Couldn’t load anime" : "Connect DreaMedia to load anime");
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
loadConfiguration()
  .catch((error) => {
    status("configStatus", `Couldn’t read settings: ${error.message}`, "err");
    setConnection("err", "Settings unavailable");
    return false;
  })
  .then((configured) => loadLists(configured));
