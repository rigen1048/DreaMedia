
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
