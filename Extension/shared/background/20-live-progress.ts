interface BgLiveProgressPayload {
  entry_id: number;
  season: number;
  episode: number;
  position_seconds: number;
  event_time_ms?: string | number | null;
}

async function liveGql(query: string, p: BgLiveProgressPayload): Promise<boolean> {
  const variables = {
    entryId: p.entry_id, season: p.season, episode: p.episode, positionSeconds: p.position_seconds,
    eventTimeMs: p.event_time_ms == null ? null : String(p.event_time_ms),
  };
  try {
    const data = await gqlWs<{ liveProgress?: unknown; liveEnd?: unknown }>(query, variables);
    return data.liveProgress === true || data.liveEnd === true;
  } catch (_error) {
    return false;
  }
}

function reconnectAfterConfigurationChange(): void {
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
