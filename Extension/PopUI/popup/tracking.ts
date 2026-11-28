/**
 * Anime tracking state and rendering — per-tab video tracking status.
 * No `any` type permitted.
 */

import { $, send, currentTab, formatClock } from "./shared";

let trackingRequestInFlight = false;

export interface TrackingData {
  bound: boolean;
  entryId: number | null;
  title: string;
  season: number | null;
  episode: number | null;
  episodeSource: string;
  positionSeconds: number | null;
  durationSeconds: number | null;
  playing: boolean;
  state: string;
  pageTitle: string;
  urlEpisode: number | null;
  urlSeason: number | null;
  urlEpisodeSource: string;
  url: string;
  sampledAt: number;
}

export function renderTracking(
  data: TrackingData | null,
  animeTrackingEnabled: boolean,
  animeTrackingSite: boolean
): void {
  const card = $("trackingCard");
  const title = $("trackingTitle");
  const detail = $("trackingDetail");
  const clock = $("trackingTime");
  if (!data) {
    card.dataset.state = "idle";
    title.textContent = !animeTrackingEnabled
      ? "Anime tracking paused"
      : "Starting anime tracking…";
    detail.textContent = !animeTrackingEnabled
      ? "Enable this domain to match the page and video"
      : "Matching the page title and locating the video";
    clock.textContent = "—:—";
    return;
  }
  if (!data.bound || !data.entryId) {
    card.dataset.state = "idle";
    const pageTitle = String(data.pageTitle ?? "").trim();
    title.textContent =
      data.state === "matching"
        ? pageTitle || "Matching page title…"
        : "No tracked anime match";
    detail.textContent =
      data.state === "matching"
        ? data.urlEpisode != null
          ? `Matching tracked titles · URL suggests episode ${data.urlEpisode}`
          : "Matching this page title against tracked anime"
        : data.urlEpisode != null
          ? `Page: ${pageTitle || "unknown title"} · URL suggests episode ${data.urlEpisode}`
          : `Page: ${pageTitle || "unknown title"}`;
    clock.textContent = "—:—";
    return;
  }

  const animeTitle = data.title || `Anime ${data.entryId}`;
  const season = Number(data.season) > 0 ? `S${data.season} · ` : "";
  const episode = data.episode != null ? `Episode ${data.episode}` : "Episode unknown";
  const sources: Record<string, string> = {
    url: "URL",
    title: "title",
    cursor: "saved cursor",
    ended: "ended +1",
  };
  const source = sources[data.episodeSource] ?? data.episodeSource ?? "estimate";
  const stateText: Record<string, string> = {
    playing: "Tracking",
    paused: "Paused",
    waiting: "Waiting for video",
    ended:
      data.episodeSource === "ended" ? "Next episode estimate" : "Episode ended",
    unmatched: "Not matched",
  };
  const stateLabel = stateText[data.state] || "Tracking";
  card.dataset.state =
    data.state === "playing" || data.state === "paused" || data.state === "ended"
      ? data.state
      : "idle";
  title.textContent = animeTitle;
  detail.textContent = `${stateLabel} · ${season}${episode} · ${source}`;
  const current = formatClock(data.positionSeconds ?? 0);
  const total = formatClock(data.durationSeconds ?? 0);
  clock.textContent =
    data.durationSeconds != null && total !== "—:—"
      ? `${current} / ${total}`
      : current;
}

export async function refreshTrackingStatus(
  animeTrackingEnabled: boolean,
  animeTrackingSite: boolean
): Promise<void> {
  if (trackingRequestInFlight) return;
  trackingRequestInFlight = true;
  try {
    const tab = await currentTab();
    if (!tab?.id) {
      renderTracking(null, animeTrackingEnabled, animeTrackingSite);
      return;
    }
    if (!animeTrackingSite) {
      renderTracking(null, animeTrackingEnabled, animeTrackingSite);
      return;
    }
    const response = await send("dreamedia:trackingStatus", { tabId: tab.id });
    if (response.ok && response.data) {
      renderTracking(response.data as TrackingData, animeTrackingEnabled, animeTrackingSite);
    } else {
      renderTracking(null, animeTrackingEnabled, animeTrackingSite);
    }
  } catch {
    renderTracking(null, animeTrackingEnabled, animeTrackingSite);
  } finally {
    trackingRequestInFlight = false;
  }
}
