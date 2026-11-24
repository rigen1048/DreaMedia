interface BgScanResult {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

// ---- message lane ----

async function scanYoutubeSubscriptions(tabId: number): Promise<BgScanResult> {
  const tab = await chrome.tabs.get(tabId);
  let url: URL;
  try { url = new URL(tab.url || ""); } catch (_e) { throw new Error("Open YouTube's channel subscriptions page first."); }
  if (!YOUTUBE_IMPORT_HOSTS.has(url.hostname.toLowerCase()) || url.pathname !== "/feed/channels") {
    throw new Error("Open YouTube's channel subscriptions page (/feed/channels) first.");
  }
  const scripting = chrome.scripting as unknown as Pick<BgDynamicScriptingApi, "executeScript"> | undefined;
  if (typeof scripting?.executeScript === "function") {
    await scripting.executeScript({
      target: { tabId },
      files: ["modules/youtube-import.js"],
    });
  } else {
    const api = (typeof browser !== "undefined" ? browser : chrome) as BgLegacyBrowserApi;
    if (typeof api.tabs?.executeScript !== "function") {
      throw new Error("This browser does not support active-tab import scanning.");
    }
    await api.tabs.executeScript(tabId, { file: "modules/youtube-import.js" });
  }
  const result = await chrome.tabs.sendMessage<BgScanResult>(tabId, { type: "dreamedia:scanYoutubeSubscriptions" });
  if (!result?.ok) throw new Error(result?.error || "Could not scan the subscriptions page.");
  return result;
}
