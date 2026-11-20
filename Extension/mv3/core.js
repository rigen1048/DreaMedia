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

  function attach(video, handlers, intervalMs) {
    video.dataset.dreamedia = "true";
    sessionStorage.setItem(`dreamedia_${location.hostname}`, generateSelector(video));
    video.addEventListener("ended", () => handlers.onEnded(video));
    video.addEventListener("pause", () => handlers.onPause(video));
    setInterval(() => {
      if (!video.paused) handlers.onInterval(video);
    }, intervalMs);
  }

  // Phase 4: blocked-content disclaimer. User data (title/reason) only
  // ever goes through textContent — never innerHTML.
  function showBlocked(title, reason) {
    if (document.getElementById("dreamedia-blocked")) return;
    const overlay = document.createElement("div");
    overlay.id = "dreamedia-blocked";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(10,10,12,.96);" +
      "display:flex;align-items:center;justify-content:center;" +
      "font-family:ui-sans-serif,system-ui,sans-serif;color:#fafafa;";
    const card = document.createElement("div");
    card.style.cssText = "max-width:420px;padding:28px;text-align:center;";
    const heading = document.createElement("div");
    heading.style.cssText = "font-size:18px;font-weight:700;margin-bottom:10px;";
    heading.textContent = "Blocked on DreaMedia";
    const what = document.createElement("div");
    what.style.cssText = "font-size:13px;color:#a1a1aa;margin-bottom:8px;";
    what.textContent = title || "This content is on your blocked list.";
    const why = document.createElement("div");
    why.style.cssText = "font-size:12px;color:#f87171;margin-bottom:20px;";
    why.textContent = reason ? `Reason: ${reason}` : "";
    const back = document.createElement("button");
    back.textContent = "Take me back";
    back.style.cssText =
      "padding:9px 18px;border:0;border-radius:8px;background:#fafafa;color:#18181b;" +
      "font-weight:600;cursor:pointer;margin-right:8px;";
    back.addEventListener("click", () => history.back());
    const dismiss = document.createElement("button");
    dismiss.textContent = "Continue anyway";
    dismiss.style.cssText =
      "padding:9px 18px;border:1px solid #3f3f46;border-radius:8px;background:transparent;" +
      "color:#d4d4d8;cursor:pointer;";
    dismiss.addEventListener("click", () => overlay.remove());
    card.append(heading, what, why, back, dismiss);
    overlay.append(card);
    (document.body || document.documentElement).append(overlay);
  }

  window.DreaMediaCore = {
    REPORT_INTERVAL_MS,
    showBlocked,
    start(handlers, intervalMs = REPORT_INTERVAL_MS) {
      const observer = new MutationObserver(() => {
        const v = findVideo();
        if (v) attach(v, handlers, intervalMs);
      });
      observer.observe(document, { childList: true, subtree: true });
      let lastUrl = location.href;
      setInterval(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          sessionStorage.removeItem(`dreamedia_${location.hostname}`);
          const v = findVideo();
          if (v) attach(v, handlers, intervalMs);
        }
      }, 1000);
      const v = findVideo();
      if (v) attach(v, handlers, intervalMs);
    },
  };
})();
