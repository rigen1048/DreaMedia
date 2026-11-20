/* DreaMedia shared core (ext v2): site-agnostic video attach, SyncNwatch
 * model — first ready <video>, robust selector cached per host,
 * MutationObserver + URL-change re-attach. Loaded on allowlisted domains
 * ONLY (dynamic registration from ext_domains), before the media module.
 * Exposes window.DreaMediaCore.start(handlers). */
(() => {
  const REPORT_INTERVAL_MS = 15000;

  function generateSelector(video) {
    if (video.id) return `#${CSS.escape(video.id)}`;
    if (video.classList.length > 0) return `video.${Array.from(video.classList).join(".")}`;
    const path = [];
    let el = video;
    while (el && el !== document.body) {
      let selector = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
        if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(el) + 1})`;
      }
      path.unshift(selector);
      el = parent;
    }
    return path.join(" > ");
  }

  function findVideo() {
    const host = location.hostname;
    const saved = sessionStorage.getItem(`dreamedia_${host}`);
    if (saved) {
      const v = document.querySelector(saved);
      if (v && !v.dataset.dreamedia && v.readyState > 0) return v;
      sessionStorage.removeItem(`dreamedia_${host}`);
    }
    for (const v of document.getElementsByTagName("video")) {
      if (!v.dataset.dreamedia && v.readyState > 0) return v;
    }
    return null;
  }

  function attach(video, handlers) {
    video.dataset.dreamedia = "true";
    sessionStorage.setItem(`dreamedia_${location.hostname}`, generateSelector(video));
    video.addEventListener("ended", () => handlers.onEnded(video));
    video.addEventListener("pause", () => handlers.onPause(video));
    setInterval(() => {
      if (!video.paused) handlers.onInterval(video);
    }, REPORT_INTERVAL_MS);
  }

  window.DreaMediaCore = {
    REPORT_INTERVAL_MS,
    start(handlers) {
      const observer = new MutationObserver(() => {
        const v = findVideo();
        if (v) attach(v, handlers);
      });
      observer.observe(document, { childList: true, subtree: true });
      let lastUrl = location.href;
      setInterval(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          sessionStorage.removeItem(`dreamedia_${location.hostname}`);
          const v = findVideo();
          if (v) attach(v, handlers);
        }
      }, 1000);
      const v = findVideo();
      if (v) attach(v, handlers);
    },
  };
})();
