
async function liveGql(query, p) {
  const variables = {
    entryId: p.entry_id, season: p.season, episode: p.episode, positionSeconds: p.position_seconds,
    eventTimeMs: p.event_time_ms == null ? null : String(p.event_time_ms),
  };
  try {
    const data = await gqlWs(query, variables);
    return data.liveProgress === true || data.liveEnd === true;
  } catch (_error) {
    return false;
  }
}

function reconnectAfterConfigurationChange() {
  wsAuthRejected = false;
  wsAuthFailureReason = "";
  wsRetryAttempt = 0;
  void (async () => {
    try { await chrome.storage.local.set({ domains: null }); } catch (_e) { /* next wake retries */ }
    stopWsForNoEnabledSite();
    void refreshAll();
  })();
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && (changes.backendUrl || changes.token)) {
    reconnectAfterConfigurationChange();
  }
});
