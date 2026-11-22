const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionRoot = path.join(__dirname, "..");
const animeSource = fs.readFileSync(
  path.join(extensionRoot, "shared/modules/anime.js"),
  "utf8",
);

function loadAnimeModule() {
  const messages = [];
  const timers = [];
  let runtimeListener;
  let coreHandlers;
  const video = {
    isConnected: true,
    currentTime: 87.8,
    duration: 1435.2,
    paused: false,
    ended: false,
  };
  const window = {
    DreaMediaAnimeUrl: {
      parse: () => ({
        season: 1,
        episode: 28,
        source: "path:episode-marker",
        confidence: "high",
      }),
    },
    DreaMediaCore: {
      start(handlers, interval) {
        coreHandlers = handlers;
        assert.equal(interval, 5000);
      },
      showBlocked() {},
    },
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) { runtimeListener = listener; },
      },
      sendMessage(message, callback) {
        messages.push(message);
        callback?.();
      },
    },
  };
  const document = {
    title: "Naruto Shippuden Episode 28",
    querySelector(selector) {
      if (selector === 'meta[property="og:title"]') {
        return { content: "Naruto Shippuden Episode 28" };
      }
      if (selector === "h1") return { textContent: "Naruto Shippuden" };
      return null;
    },
  };
  const sandbox = {
    window,
    document,
    chrome,
    location: { href: "https://anime.example/watch/naruto-76396/ep-28" },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    setInterval(callback, delay) {
      timers.push({ callback, delay, interval: true });
      return timers.length;
    },
    clearTimeout() {},
    console: { debug() {} },
  };
  vm.runInNewContext(animeSource, sandbox, { filename: "anime.js" });
  return {
    chrome,
    coreHandlers,
    document,
    messages,
    runtimeListener,
    timers,
    video,
    window,
  };
}

test("auto-matches the page title and reports the bound video's episode and timestamp", () => {
  const state = loadAnimeModule();
  const initialMatch = state.timers.find((timer) => timer.delay === 500);
  assert.ok(initialMatch, "automatic matching should be scheduled immediately");
  initialMatch.callback();

  const anchorRequest = state.messages.find((message) => message.type === "dreamedia:anchor");
  assert.ok(anchorRequest, "the module should ask the backend to match without a manual bind");
  assert.ok(anchorRequest.candidates.includes("Naruto Shippuden Episode 28"));
  assert.equal(anchorRequest.url, "https://anime.example/watch/naruto-76396/ep-28");
  assert.equal(anchorRequest.urlHint.episode, 28);

  state.runtimeListener({
    type: "dreamedia:bind",
    binding: {
      entryId: 501,
      title: "Naruto",
      season: 1,
      episode: 28,
      episodeSource: "url",
    },
  }, {}, () => {});
  state.coreHandlers.onAttach(state.video);
  state.coreHandlers.onInterval(state.video);

  const progress = state.messages.find((message) => message.type === "dreamedia:progress");
  assert.equal(progress.payload.entry_id, 501);
  assert.equal(progress.payload.episode, 28);
  assert.equal(progress.payload.position_seconds, 87);

  const snapshot = {};
  state.runtimeListener({ type: "dreamedia:getTrackingStatus" }, {}, (data) => Object.assign(snapshot, data));
  assert.equal(snapshot.title, "Naruto");
  assert.equal(snapshot.episode, 28);
  assert.equal(snapshot.positionSeconds, 87);
  assert.equal(snapshot.durationSeconds, 1435);
  assert.equal(snapshot.state, "playing");

  state.video.ended = true;
  state.video.paused = true;
  state.coreHandlers.onEnded(state.video);
  state.runtimeListener({ type: "dreamedia:getTrackingStatus" }, {}, (data) => Object.assign(snapshot, data));
  assert.equal(snapshot.episode, 29);
  assert.equal(snapshot.episodeSource, "ended");
});

test("anime bindings are per-tab memory and the popup has no manual bind control", () => {
  const popup = fs.readFileSync(path.join(extensionRoot, "shared/popup.html"), "utf8");
  const moduleSource = fs.readFileSync(path.join(extensionRoot, "shared/modules/anime.js"), "utf8");
  assert.doesNotMatch(popup, /Bind anime|Bind tab|trackTab|trackPanel/);
  assert.doesNotMatch(moduleSource, /chrome\.storage\.(?:session|local)/);
  assert.match(popup, /id="trackingCard"/);
});
