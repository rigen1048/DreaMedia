/* DreaMedia popup (D55): subscribe-from-page (HydraTracker model),
 * playlist add, and anime binding for the content script's watch tracking. */
const $ = (id) => document.getElementById(id);

function send(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => resolve(resp || { ok: false, error: "no response" }));
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

// ---- config ----
(async () => {
  const cfg = await chrome.storage.local.get(["backendUrl", "token"]);
  if (cfg.backendUrl) $("backendUrl").value = cfg.backendUrl;
  if (cfg.token) $("token").value = cfg.token;
})();

$("saveConfig").addEventListener("click", async () => {
  await chrome.storage.local.set({ backendUrl: $("backendUrl").value.trim(), token: $("token").value.trim() });
  const r = await send("dreamedia:ping");
  status("configStatus", r.ok ? "Connected ✓" : `Failed: ${r.error}`, r.ok ? "ok" : "err");
  if (r.ok) loadLists();
});

// ---- conditional fields ----
$("kind").addEventListener("change", () => {
  $("words").style.display = $("kind").value === "wordscan" ? "" : "none";
  $("rank").style.display = $("kind").value === "random" ? "" : "none";
});

// ---- subscribe ----
$("subscribe").addEventListener("click", async () => {
  const tab = await currentTab();
  const kind = $("kind").value;
  const body = { kind, link: tab.url };
  if (kind === "wordscan") body.words = $("words").value.split(",").map((w) => w.trim()).filter(Boolean);
  if (kind === "random") body.rank = $("rank").value;
  status("subStatus", "Resolving…");
  const r = await send("dreamedia:subscribe", { body });
  status("subStatus", r.ok && r.data.ok ? "Subscribed ✓" : `Failed: ${r.error || r.data?.error}`, r.ok && r.data.ok ? "ok" : "err");
});

// ---- playlist add ----
$("addVideo").addEventListener("click", async () => {
  const tab = await currentTab();
  const cardId = $("card").value;
  if (!cardId) return status("cardStatus", "Pick a playlist first", "err");
  status("cardStatus", "Resolving…");
  const r = await send("dreamedia:addItem", { cardId, links: [tab.url] });
  status("cardStatus", r.ok ? `Added ✓ (${r.data.added}/${r.data.requested})` : `Failed: ${r.error}`, r.ok ? "ok" : "err");
});

// ---- anime binding ----
$("bind").addEventListener("click", async () => {
  const tab = await currentTab();
  const entryId = Number($("entry").value);
  if (!entryId) return status("bindStatus", "Pick an entry first", "err");
  const binding = { entryId, season: Number($("season").value) || 1, episode: Number($("episode").value) || 1 };
  await (chrome.storage.session || chrome.storage.local).set({ dreamediaBinding: binding });
  await chrome.tabs.sendMessage(tab.id, { type: "dreamedia:bind", binding }).catch(() => {});
  status("bindStatus", "Bound ✓ — timestamps sync every 15s while playing", "ok");
});

// ---- lists ----
async function loadLists() {
  const cards = await send("dreamedia:cards");
  if (cards.ok) {
    $("card").innerHTML = (cards.data.cards || [])
      .map((c) => `<option value="${c.id}">${c.name || "Untitled"} (${c.done}/${c.total})</option>`)
      .join("") || "<option value=''>No playlists yet</option>";
  }
  const entries = await send("dreamedia:aniEntries");
  if (entries.ok) {
    $("entry").innerHTML = (entries.data.entries || [])
      .map((e) => `<option value="${e.id}">${e.title}</option>`)
      .join("") || "<option value=''>No anime tracked yet</option>";
  }
}
loadLists();
