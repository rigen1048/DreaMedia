
// ---- message lane ----

async function scanYoutubeSubscriptions(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let url;
  try { url = new URL(tab.url || ""); } catch (_e) { throw new Error("Open YouTube's channel subscriptions page first."); }
  if (!YOUTUBE_IMPORT_HOSTS.has(url.hostname.toLowerCase()) || url.pathname !== "/feed/channels") {
    throw new Error("Open YouTube's channel subscriptions page (/feed/channels) first.");
  }
  if (chrome.scripting?.executeScript) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["modules/youtube-import.js"],
    });
  } else if (chrome.tabs?.executeScript) {
    await chrome.tabs.executeScript(tabId, { file: "modules/youtube-import.js" });
  } else {
    throw new Error("This browser does not support active-tab import scanning.");
  }
  const result = await chrome.tabs.sendMessage(tabId, { type: "dreamedia:scanYoutubeSubscriptions" });
  if (!result?.ok) throw new Error(result?.error || "Could not scan the subscriptions page.");
  return result;
}
