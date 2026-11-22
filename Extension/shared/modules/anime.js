/* Site-agnostic anime watch tracking for allowlisted 'ani' domains.
 * Titles identify the tracked entry on the backend; URL hints identify the
 * episode; the attached video supplies the playback position. */
(() => {
  if (window.__dreamediaAnimeStarted) return;
  window.__dreamediaAnimeStarted = true;
  // Each tab owns its binding in this isolated content-script world. Never
  // restore the old global storage key, which leaked one tab's anime into all.
  window.__dreamediaBinding = null;
  const LIVE_INTERVAL_MS = 5000;
  let lastEventTimeMs = 0;
  let activeVideo = null;
  let activeEpisode = null;
  let anchorAttempts = 0;
  let anchorRetryTimer = null;

  function urlHint() {
    return window.DreaMediaAnimeUrl?.parse(location.href) || {
      season: null, episode: null, source: "", confidence: "none",
    };
  }

  function payload(video) {
    const binding = window.__dreamediaBinding;
    if (!binding || !binding.entryId) return null;
    lastEventTimeMs = Math.max(Date.now(), lastEventTimeMs + 1);
    return {
      entry_id: binding.entryId,
      season: binding.season,
      episode: binding.episode,
      position_seconds: Math.floor(video.currentTime || 0),
      event_time_ms: String(lastEventTimeMs),
    };
  }

  function send(type, body = {}) {
    chrome.runtime.sendMessage({ type, ...body }, () => void chrome.runtime.lastError);
  }

  function trackingSnapshot(video = activeVideo, forcedState = "") {
    const binding = window.__dreamediaBinding;
    const liveVideo = video?.isConnected
      ? video
      : document.querySelector('video[data-dreamedia="true"]');
    const hint = urlHint();
    let state = forcedState;
    if (!state) {
      if (!binding?.entryId) state = anchorAttempts < 6 ? "matching" : "unmatched";
      else if (!liveVideo) state = "waiting";
      else if (liveVideo.ended) state = "ended";
      else if (liveVideo.paused) state = "paused";
      else state = "playing";
    }
    return {
      bound: Boolean(binding?.entryId),
      entryId: binding?.entryId ?? null,
      title: binding?.title || "",
      season: binding?.season ?? null,
      episode: binding?.episode ?? null,
      episodeSource: binding?.episodeSource || "",
      positionSeconds: liveVideo ? Math.floor(liveVideo.currentTime || 0) : null,
      durationSeconds: liveVideo && Number.isFinite(liveVideo.duration)
        ? Math.floor(liveVideo.duration) : null,
      playing: Boolean(liveVideo && !liveVideo.paused && !liveVideo.ended),
      state,
      pageTitle: document.title || "",
      urlEpisode: hint.episode,
      urlSeason: hint.season,
      urlEpisodeSource: hint.source,
      url: location.href,
      sampledAt: Date.now(),
    };
  }

  function pageCandidates() {
    const list = [document.title];
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content) list.push(og.content);
    const h1 = document.querySelector("h1");
    if (h1?.textContent) list.push(h1.textContent.trim());
    return list.filter(Boolean);
  }

  function tryAnchor(force = false) {
    if ((!force && window.__dreamediaBinding?.entryId) || anchorAttempts >= 6) return;
    anchorAttempts += 1;
    send("dreamedia:anchor", {
      candidates: pageCandidates(),
      url: location.href,
      urlHint: urlHint(),
    });
  }

  // Match as soon as the enabled content script starts; retry while a title
  // settles, stopping after a match or six unanswered attempts.
  setTimeout(() => tryAnchor(), 500);
  setInterval(() => tryAnchor(), 5000);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "dreamedia:bind") {
      window.__dreamediaBinding = msg.binding;
      activeEpisode = msg.binding?.episode ?? null;
      console.debug("[DreaMedia] bound to entry", msg.binding);
    } else if (msg.type === "dreamedia:blocked") {
      window.DreaMediaCore.showBlocked(msg.title || "This anime is on your blocked list.", msg.reason);
    } else if (msg.type === "dreamedia:getTrackingStatus") {
      sendResponse(trackingSnapshot());
    }
  });

  window.DreaMediaCore.start({
    onAttach: (video) => {
      activeVideo = video;
      activeEpisode = window.__dreamediaBinding?.episode ?? urlHint().episode;
    },
    onNavigate: () => {
      anchorAttempts = 0;
      const hint = urlHint();
      const binding = window.__dreamediaBinding;
      // A URL change on an already-bound SPA tab is new episode evidence.
      if (binding?.entryId && hint.episode != null) {
        binding.episode = hint.episode;
        if (hint.season != null) binding.season = hint.season;
        binding.episodeSource = "url";
        activeEpisode = hint.episode;
      }
      if (anchorRetryTimer) clearTimeout(anchorRetryTimer);
      anchorRetryTimer = setTimeout(() => {
        anchorRetryTimer = null;
        tryAnchor(true);
      }, 1500);
    },
    onInterval: (video) => {
      activeVideo = video;
      const p = payload(video);
      if (p) send("dreamedia:progress", { payload: p });
    },
    onPause: (video) => {
      activeVideo = video;
      const p = payload(video);
      if (p) send("dreamedia:liveEnd", { payload: p });
    },
    onEnded: (video) => {
      activeVideo = video;
      const binding = window.__dreamediaBinding;
      if (!binding) return;
      const p = payload(video);
      if (p) send("dreamedia:liveEnd", { payload: p });
      // If navigation already exposed the next route, trust it. Otherwise the
      // finished video is the attached episode and the popup should advance
      // even when the site leaves its URL unchanged after playback.
      const routeEpisode = urlHint().episode;
      const finishedEpisode = Number(activeEpisode ?? binding.episode) || 0;
      if (routeEpisode != null && routeEpisode > finishedEpisode) {
        binding.episode = routeEpisode;
        binding.episodeSource = "url";
      } else {
        binding.episode = finishedEpisode + 1;
        binding.episodeSource = "ended";
      }
      activeEpisode = binding.episode;
    },
  }, LIVE_INTERVAL_MS);
})();
