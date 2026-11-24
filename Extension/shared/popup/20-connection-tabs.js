
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
