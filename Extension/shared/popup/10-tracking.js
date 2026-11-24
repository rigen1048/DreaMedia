
let trackingRequestInFlight = false;
let animeTrackingSite = false;
let animeTrackingEnabled = false;

function formatClock(value) {
  if (!Number.isFinite(value) || value < 0) return "—:—";
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function renderTracking(data) {
  const card = $("trackingCard");
  const title = $("trackingTitle");
  const detail = $("trackingDetail");
  const clock = $("trackingTime");
  if (!data) {
    card.dataset.state = "idle";
    title.textContent = !animeTrackingEnabled ? "Anime tracking paused" : "Starting anime tracking…";
    detail.textContent = !animeTrackingEnabled
      ? "Enable this domain to match the page and video"
      : "Matching the page title and locating the video";
    clock.textContent = "—:—";
    return;
  }
  if (!data.bound || !data.entryId) {
    card.dataset.state = "idle";
    const pageTitle = String(data.pageTitle || "").trim();
    title.textContent = data.state === "matching"
      ? (pageTitle || "Matching page title…")
      : "No tracked anime match";
    detail.textContent = data.state === "matching"
      ? (data.urlEpisode != null
        ? `Matching tracked titles · URL suggests episode ${data.urlEpisode}`
        : "Matching this page title against tracked anime")
      : (data.urlEpisode != null
        ? `Page: ${pageTitle || "unknown title"} · URL suggests episode ${data.urlEpisode}`
        : `Page: ${pageTitle || "unknown title"}`);
    clock.textContent = "—:—";
    return;
  }

  const animeTitle = data.title || `Anime ${data.entryId}`;
  const season = Number(data.season) > 0 ? `S${data.season} · ` : "";
  const episode = data.episode != null ? `Episode ${data.episode}` : "Episode unknown";
  const sources = { url: "URL", title: "title", cursor: "saved cursor", ended: "ended +1" };
  const source = sources[data.episodeSource] || data.episodeSource || "estimate";
  const stateText = {
    playing: "Tracking",
    paused: "Paused",
    waiting: "Waiting for video",
    ended: data.episodeSource === "ended" ? "Next episode estimate" : "Episode ended",
    unmatched: "Not matched",
  }[data.state] || "Tracking";
  card.dataset.state = data.state === "playing" || data.state === "paused" || data.state === "ended"
    ? data.state : "idle";
  title.textContent = animeTitle;
  detail.textContent = `${stateText} · ${season}${episode} · ${source}`;
  const current = formatClock(data.positionSeconds);
  const total = formatClock(data.durationSeconds);
  clock.textContent = data.durationSeconds != null && total !== "—:—"
    ? `${current} / ${total}` : current;
}

async function refreshTrackingStatus() {
  if (trackingRequestInFlight) return;
  trackingRequestInFlight = true;
  try {
    const tab = await currentTab();
    if (!tab?.id) {
      renderTracking(null);
      return;
    }
    if (!animeTrackingSite) {
      renderTracking(null);
      return;
    }
    const response = await send("dreamedia:trackingStatus", { tabId: tab.id });
    renderTracking(response.ok ? response.data : null);
  } catch (_error) {
    renderTracking(null);
  } finally {
    trackingRequestInFlight = false;
  }
}
