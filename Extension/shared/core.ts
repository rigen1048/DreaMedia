/**
 * DreaMedia Shared Core — Content Script Core
 * Site-agnostic video attach, SyncNwatch model — first ready <video>,
 * robust selector cached per host, MutationObserver + URL-change
 * re-attach. Loaded on allowlisted domains ONLY (dynamic registration
 * from ext_domains), before the media module.
 * Exposes window.DreaMediaCore.start(handlers).
 * No `any` type permitted.
 */

interface VideoAttachHandlers {
  onAttach?: (video: HTMLVideoElement) => void;
  onEnded?: (video: HTMLVideoElement) => void;
  onPause?: (video: HTMLVideoElement) => void;
  onInterval?: (video: HTMLVideoElement) => void;
  onNavigate?: (lastUrl: string) => void;
}

interface CoreApi {
  REPORT_INTERVAL_MS: number;
  showBlocked: (title: string, reason: string | null) => void;
  start: (
    handlers: VideoAttachHandlers,
    intervalMs?: number
  ) => void;
}

const REPORT_INTERVAL_MS = 15000;

function generateSelector(video: HTMLVideoElement): string {
  if (video.id) return `#${CSS.escape(video.id)}`;
  if (video.classList.length > 0) {
    return `video.${Array.from(video.classList).join(".")}`;
  }
  const path: string[] = [];
  let el: HTMLElement | null = video;
  while (el && el !== document.body) {
    const currentVideo: HTMLElement | null = el;
    if (!currentVideo) break;
    let selector = currentVideo.tagName.toLowerCase();
    const parent: HTMLElement | null = currentVideo.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s: Element) => s.tagName === currentVideo.tagName
      );
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(currentVideo) + 1})`;
      }
    }
    path.unshift(selector);
    el = parent;
  }
  return path.join(" > ");
}

function findVideo(): HTMLVideoElement | null {
  const host = location.hostname;
  const saved = sessionStorage.getItem(`dreamedia_${host}`);
  if (saved) {
    const v = document.querySelector(saved);
    if (
      v &&
      !(v as HTMLElement).dataset.dreamedia &&
      (v as HTMLVideoElement).readyState > 0
    ) {
      return v as HTMLVideoElement;
    }
    sessionStorage.removeItem(`dreamedia_${host}`);
  }
  for (const v of Array.from(document.getElementsByTagName("video"))) {
    if (
      !(v as HTMLElement).dataset.dreamedia &&
      (v as HTMLVideoElement).readyState > 0
    ) {
      return v as HTMLVideoElement;
    }
  }
  return null;
}

let activeVideo: HTMLVideoElement | null = null;
let activeInterval: number | null = null;
let activeEndedHandler: (() => void) | null = null;
let activePauseHandler: (() => void) | null = null;

function detachActiveVideo(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
  if (activeVideo) {
    if (activeEndedHandler) {
      activeVideo.removeEventListener("ended", activeEndedHandler);
    }
    if (activePauseHandler) {
      activeVideo.removeEventListener("pause", activePauseHandler);
    }
  }
  activeVideo = null;
  activeEndedHandler = null;
  activePauseHandler = null;
}

function attach(
  video: HTMLVideoElement,
  handlers: VideoAttachHandlers,
  intervalMs: number
): void {
  if (activeVideo === video) return;
  detachActiveVideo();
  (video as HTMLElement).dataset.dreamedia = "true";
  sessionStorage.setItem(`dreamedia_${location.hostname}`, generateSelector(video));
  activeVideo = video;
  activeEndedHandler = () => handlers.onEnded?.(video);
  activePauseHandler = () => handlers.onPause?.(video);
  video.addEventListener("ended", activeEndedHandler);
  video.addEventListener("pause", activePauseHandler);
  handlers.onAttach?.(video);
  activeInterval = setInterval(() => {
    if (!video.isConnected) {
      if (activeVideo === video) detachActiveVideo();
      return;
    }
    if (!video.paused) handlers.onInterval?.(video);
  }, intervalMs);
}

function showBlocked(title: string, reason: string | null): void {
  if (document.getElementById("dreamedia-blocked")) return;
  const overlay = document.createElement("div");
  overlay.id = "dreamedia-blocked";
  overlay.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.8);" +
    "display:grid;place-items:center;overflow:auto;padding:20px;box-sizing:border-box;";
  const shadow = overlay.attachShadow({ mode: "open" });
  const card = document.createElement("section");
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "blocked-heading");
  card.setAttribute(
    "aria-describedby",
    reason ? "blocked-content blocked-reason" : "blocked-content"
  );
  card.style.cssText =
    "--dm-card:oklch(.18 0 0);--dm-text:oklch(.985 0 0);--dm-muted:oklch(.708 0 0);" +
    "--dm-primary:oklch(.92 0 0);--dm-primary-text:oklch(.205 0 0);--dm-line:oklch(1 0 0 / 15%);" +
    "color-scheme:dark;width:100%;max-width:25rem;box-sizing:border-box;padding:1.5rem;text-align:left;" +
    "color:var(--dm-text);background:var(--dm-card);border:1px solid var(--dm-line);border-radius:.625rem;" +
    "box-shadow:0 16px 50px #0008;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;";
  const label = document.createElement("div");
  label.style.cssText = "font-size:.75rem;font-weight:550;color:var(--dm-muted);";
  label.textContent = "DreaMedia";
  const heading = document.createElement("h2");
  heading.id = "blocked-heading";
  heading.style.cssText = "font-size:1.125rem;font-weight:620;line-height:1.3;letter-spacing:-.02em;margin:.375rem 0 .5rem;";
  heading.textContent = "Blocked content";
  const what = document.createElement("div");
  what.id = "blocked-content";
  what.style.cssText = "color:var(--dm-muted);overflow-wrap:anywhere;";
  what.textContent = title || "This content is on your blocked list.";
  const why = document.createElement("div");
  why.id = "blocked-reason";
  why.style.cssText = "margin-top:.75rem;padding:.5rem .75rem;border:1px solid var(--dm-line);border-radius:.5rem;color:var(--dm-muted);overflow-wrap:anywhere;";
  why.textContent = reason ? `Reason: ${reason}` : "";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5rem;margin-top:1.25rem;";
  const buttonStyle = "min-height:2rem;padding:.375rem .75rem;border-radius:.5rem;font:550 .75rem system-ui,sans-serif;cursor:pointer;";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Go back";
  back.style.cssText = `${buttonStyle}border:1px solid transparent;background:var(--dm-primary);color:var(--dm-primary-text);`;
  back.addEventListener("click", () => history.back());
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Continue anyway";
  dismiss.style.cssText = `${buttonStyle}border:1px solid var(--dm-line);background:transparent;color:var(--dm-text);`;
  const previousFocus: HTMLElement | null = document.activeElement as HTMLElement | null;
  dismiss.addEventListener("click", () => {
    overlay.remove();
    previousFocus?.focus?.();
  });
  (shadow as EventTarget).addEventListener("keydown", (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Tab") return;
    keyboardEvent.preventDefault();
    const active = shadow.activeElement as HTMLElement | null;
    (active === back ? dismiss : back).focus();
  });
  actions.append(back, dismiss);
  card.append(label, heading, what);
  if (reason) card.append(why);
  card.append(actions);
  shadow.append(card);
  (document.body || document.documentElement).append(overlay);
  back.focus();
}

const DreaMediaCore: CoreApi = {
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
        detachActiveVideo();
        sessionStorage.removeItem(`dreamedia_${location.hostname}`);
        handlers.onNavigate?.(lastUrl);
        const v = findVideo();
        if (v) attach(v, handlers, intervalMs);
      }
    }, 1000);
    const v = findVideo();
    if (v) attach(v, handlers, intervalMs);
  },
};

if (typeof window !== "undefined") {
  const win = window as Window & {
    __dreamediaCoreStarted?: boolean;
    DreaMediaCore?: CoreApi;
  };
  win.__dreamediaCoreStarted = true;
  win.DreaMediaCore = DreaMediaCore;
}

export { DreaMediaCore, REPORT_INTERVAL_MS };
export type { VideoAttachHandlers, CoreApi };
