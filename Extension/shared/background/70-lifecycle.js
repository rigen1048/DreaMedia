
// Register and start background work only after connection state has been
// initialized. No socket is opened unless an enabled site tab is present.
chrome.runtime.onStartup?.addListener(() => void refreshAll());
chrome.runtime.onInstalled?.addListener(() => void refreshAll());
chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") void refreshAll();
});
chrome.tabs?.onActivated?.addListener(() => void refreshAll());
chrome.tabs?.onRemoved?.addListener(() => void refreshAll());
chrome.alarms?.create("dreamedia:domains", { periodInMinutes: 5 });
chrome.alarms?.create("dreamedia:ws-watchdog", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamedia:domains") void refreshAll();
  if (alarm.name === "dreamedia:ws-watchdog") void ensureWs();
});
void refreshAll(); // service-worker wake / persistent background load; still site-gated
