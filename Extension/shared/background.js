/* DreaMedia background (D55, ext v2): the ONLY network lane for the
 * extension — content/popup scripts never fetch directly. It also owns
 * dynamic content-script registration: modules load ONLY on domains from
 * the user's allowlist (ext_domains), never on arbitrary pages. */
const DEFAULT_BACKEND = "http://127.0.0.1:8000";
const MEDIA_JS = {
  ani: ["core.js", "modules/anime.js"],
  yt: ["core.js", "modules/youtube.js"],
};

async function backend() {
  const r = await chrome.storage.local.get(["backendUrl", "token"]);
  return { url: (r.backendUrl || DEFAULT_BACKEND).replace(/\/$/, ""), token: r.token || "" };
}

async function call(path, options = {}) {
  const { url, token } = await backend();
  const resp = await fetch(`${url}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-DreaMedia-Token": token,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
  return data;
}

function normalizeDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").split(/[/?#]/)[0].split(":")[0];
  return d.startsWith("www.") ? d.slice(4) : d;
}

// ---- domain allowlist: fetch, cache, register ----

async function cachedDomains() {
  return (await chrome.storage.local.get("domains")).domains || [];
}

async function fetchDomains() {
  try {
    const data = await call("/ext/domains");
    await chrome.storage.local.set({ domains: data.domains || [] });
  } catch (_e) {
    // 423 (vault locked), 401 (no token yet) or backend offline: keep the
    // last cached copy — registration keeps working, possibly stale.
  }
  return cachedDomains();
}

// MV2 (Firefox) registration handles live in memory (persistent background).
const mv2Handles = new Map();

async function registerDomains(domains) {
  const wanted = [];
  for (const d of domains) {
    if (!d.domain || !d.enabled) continue;
    const js = MEDIA_JS[d.media];
    if (!js) continue;
    wanted.push({
      id: `${d.media}-${d.domain}`,
      // Chrome match patterns: *.example.com also matches example.com itself.
      matches: [`*://*.${d.domain}/*`],
      js,
    });
  }

  if (chrome.scripting?.registerContentScripts) {
    // MV3: registrations persist across service-worker restarts, so rebuild
    // the full set each time.
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
    if (wanted.length) {
      await chrome.scripting.registerContentScripts(
        wanted.map((w) => ({ id: w.id, matches: w.matches, js: w.js, runAt: "document_idle" })),
      );
    }
    return;
  }

  // MV2 Firefox: contentScripts.register (host permission covers matches).
  const api = (typeof browser !== "undefined" ? browser : chrome).contentScripts;
  if (!api?.register) return;
  for (const handle of mv2Handles.values()) handle.unregister();
  mv2Handles.clear();
  for (const w of wanted) {
    mv2Handles.set(
      w.id,
      await api.register({ matches: w.matches, js: w.js.map((file) => ({ file })), runAt: "document_idle" }),
    );
  }
}

async function refreshDomains() {
  try {
    await registerDomains(await fetchDomains());
  } catch (e) {
    console.debug("[DreaMedia] domain refresh failed", e);
  }
}

chrome.runtime.onStartup?.addListener(() => void refreshDomains());
chrome.runtime.onInstalled?.addListener(() => void refreshDomains());
void refreshDomains(); // service-worker wake / persistent background load

chrome.alarms?.create("dreamedia:domains", { periodInMinutes: 30 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamedia:domains") void refreshDomains();
});

// ---- message lane ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "dreamedia:ping":
          sendResponse({ ok: true, data: await call("/ext/ping") });
          break;
        case "dreamedia:subscribe":
          sendResponse({ ok: true, data: await call("/ext/subscribe", { method: "POST", body: msg.body }) });
          break;
        case "dreamedia:cards":
          sendResponse({ ok: true, data: await call("/ext/cards") });
          break;
        case "dreamedia:addItem":
          sendResponse({ ok: true, data: await call(`/ext/cards/${msg.cardId}/items`, { method: "POST", body: { links: msg.links } }) });
          break;
        case "dreamedia:aniEntries":
          sendResponse({ ok: true, data: await call("/ext/ani/entries") });
          break;
        case "dreamedia:progress":
          sendResponse({ ok: true, data: await call("/ext/progress", { method: "POST", body: msg.payload }) });
          break;
        case "dreamedia:domainStatus": {
          const host = normalizeDomain(msg.url);
          const hit = (await cachedDomains()).find(
            (d) => host === d.domain || host.endsWith(`.${d.domain}`),
          );
          sendResponse({ ok: true, host, registered: hit || null });
          break;
        }
        case "dreamedia:addDomain": {
          const data = await call("/ext/domains", {
            method: "POST",
            body: { domain: msg.domain, media: msg.media },
          });
          await refreshDomains();
          sendResponse({ ok: true, data });
          break;
        }
        case "dreamedia:refreshDomains":
          await refreshDomains();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true; // async response
});
