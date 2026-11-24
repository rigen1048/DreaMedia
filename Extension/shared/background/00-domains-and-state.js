/* DreaMedia background (D55, ext v2): the ONLY network lane for the
 * extension — content/popup scripts never fetch directly. It also owns
 * dynamic content-script registration: modules load ONLY on domains from
 * the user's allowlist (ext_domains), never on arbitrary pages. */
const DEFAULT_BACKEND = "http://127.0.0.1:8123";
const MEDIA_JS = {
  ani: ["core.js", "modules/anime-url.js", "modules/anime.js"],
  yt: ["core.js", "modules/youtube.js"],
};
const DEFAULT_DOMAINS = [{ id: 0, domain: "youtube.com", media: "yt", enabled: true }];
const YOUTUBE_IMPORT_HOSTS = new Set(["youtube.com", "www.youtube.com"]);
const pendingSiteDomains = new Set();
// Remove the old shared binding key: each tab now owns its own in-memory match.
void chrome.storage.local.remove("dreamediaBinding").catch(() => {});
if (chrome.storage.session?.remove) {
  void chrome.storage.session.remove("dreamediaBinding").catch(() => {});
}

async function backend() {
  const r = await chrome.storage.local.get(["backendUrl", "token"]);
  return { url: (r.backendUrl || DEFAULT_BACKEND).replace(/\/$/, ""), token: r.token || "" };
}

function normalizeDomain(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let d;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    d = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch (_e) {
    return "";
  }
  return d.startsWith("www.") ? d.slice(4) : d;
}

function domainHostPatterns(raw) {
  const host = normalizeDomain(raw);
  if (!host) return [];
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
  const matchHost = isIp || host === "localhost" ? host : `*.${host}`;
  return [`http://${matchHost}/*`, `https://${matchHost}/*`];
}

// ---- domain allowlist: fetch, cache, register ----

async function cachedDomains() {
  const stored = await chrome.storage.local.get("domains");
  if (Array.isArray(stored.domains)) return stored.domains;
  return DEFAULT_DOMAINS;
}

function urlMatchesDomain(url, domain) {
  const host = normalizeDomain(url);
  const allowed = normalizeDomain(domain);
  return Boolean(host && allowed && (host === allowed || host.endsWith(`.${allowed}`)));
}

function urlMatchesEnabledDomains(url, domains) {
  return domains.some((row) => row?.enabled && urlMatchesDomain(url, row.domain));
}

async function hasEnabledSiteTab() {
  const domains = (await cachedDomains()).filter((row) => row?.enabled);
  for (const domain of pendingSiteDomains) domains.push({ domain, enabled: true });
  if (!domains.length) return false;
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (_e) {
    return false;
  }
  return (tabs || []).some((tab) => urlMatchesEnabledDomains(tab.url || "", domains));
}

async function fetchDomains() {
  try {
    const data = await gqlWs("query { domains { id domain media enabled } }", {});
    await chrome.storage.local.set({ domains: data.domains || [] });
  } catch (_e) {
    // vault locked, no token yet, or backend offline: keep the last cached
    // copy — registration keeps working, possibly stale.
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
    const matches = domainHostPatterns(d.domain);
    if (!matches.length) continue;
    wanted.push({
      id: `${d.media}-${d.domain}`,
      matches,
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

async function injectAnimeIntoTab(tabId, tabUrl, domains = null) {
  if (!Number.isInteger(tabId) || !/^https?:/i.test(tabUrl || "")) return false;
  const rows = domains || await cachedDomains();
  const allowed = rows.some((row) => row?.media === "ani" && row.enabled &&
    urlMatchesDomain(tabUrl, row.domain));
  if (!allowed) return false;
  try {
    if (chrome.scripting?.executeScript) {
      await chrome.scripting.executeScript({ target: { tabId }, files: MEDIA_JS.ani });
    } else if (chrome.tabs?.executeScript) {
      const api = typeof browser !== "undefined" ? browser : chrome;
      for (const file of MEDIA_JS.ani) await api.tabs.executeScript(tabId, { file });
    } else {
      return false;
    }
    return true;
  } catch (error) {
    console.debug("[DreaMedia] could not activate anime tracking in tab", tabId, error);
    return false;
  }
}

async function injectAnimeIntoOpenTabs(domains) {
  const animeDomains = domains.filter((row) => row?.media === "ani" && row.enabled);
  if (!animeDomains.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_error) { return; }
  for (const tab of tabs || []) {
    if (animeDomains.some((row) => urlMatchesDomain(tab.url || "", row.domain))) {
      await injectAnimeIntoTab(tab.id, tab.url, animeDomains);
    }
  }
}

async function refreshDomains() {
  try {
    const domains = await fetchDomains();
    await registerDomains(domains);
    await injectAnimeIntoOpenTabs(domains);
  } catch (e) {
    console.debug("[DreaMedia] domain refresh failed", e);
  }
}

async function refreshAll() {
  // Reapply the last synchronized set without opening a socket on a disallowed site.
  try {
    await registerDomains(await cachedDomains());
  } catch (e) {
    console.debug("[DreaMedia] cached domain registration failed", e);
  }
  if (!(await hasEnabledSiteTab())) {
    stopWsForNoEnabledSite();
    return;
  }
  // Start the single socket only while an enabled site is open.
  void ensureWs();
  await refreshDomains();
  if (await hasEnabledSiteTab()) {
    if (wsTransportResponsive()) await fetchBlocked();
  } else {
    stopWsForNoEnabledSite();
  }
}
