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
  if (r.ok) {
    await send("dreamedia:refreshDomains");
    loadLists();
    checkSite();
  }
});

// ---- this site (ext v2: domain allowlist) ----
async function checkSite() {
  const tab = await currentTab();
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    $("siteHost").textContent = "";
    $("siteEnable").style.display = "none";
    return;
  }
  const r = await send("dreamedia:domainStatus", { url: tab.url });
  if (!r.ok) return;
  if (r.registered) {
    $("siteHost").textContent = `${r.host} — enabled (${r.registered.media === "ani" ? "anime" : "youtube"})`;
    $("siteEnable").style.display = "none";
  } else {
    $("siteHost").textContent = `${r.host} — not enabled`;
    $("siteEnable").style.display = "";
  }
}

$("enableSite").addEventListener("click", async () => {
  status("siteStatus", "Enabling…");
  const r = await send("dreamedia:addDomain", {
    domain: (await currentTab()).url,
    media: $("siteMedia").value,
  });
  status("siteStatus", r.ok ? "Enabled ✓ — tracking starts on next page load" : `Failed: ${r.error}`, r.ok ? "ok" : "err");
  if (r.ok) checkSite();
});
checkSite();

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

async function loadLists() {
  const cards = await send("dreamedia:cards");
  if (cards.ok) {
    fillOptions(
      $("card"),
      (cards.data.cards || []).map((c) => ({
        value: String(c.id),
        label: `${c.name || "Untitled"} (${c.done}/${c.total})`,
      })),
      "No playlists yet",
    );
  }
  const entries = await send("dreamedia:aniEntries");
  if (entries.ok) {
    fillOptions(
      $("entry"),
      (entries.data.entries || []).map((e) => ({ value: String(e.id), label: String(e.title ?? "") })),
      "No anime tracked yet",
    );
  }
}
loadLists();
