const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

const popupPath = path.join(__dirname, "..", "dist", "mv3", "popup.js");
const popupHtml = fs.readFileSync(path.join(__dirname, "..", "PopUI", "popup", "popup.html"), "utf8");
if (!fs.existsSync(popupPath)) {
  require("node:child_process").execSync("python3 setup.py --build-extensions-only", {
    cwd: path.join(__dirname, "..", ".."),
    stdio: "inherit",
  });
}
const popupSource = fs.readFileSync(popupPath, "utf8");
const routerSource = esbuild.transformSync(
  fs.readFileSync(path.join(__dirname, "..", "shared", "background", "60-message-router.ts"), "utf8"),
  { loader: "ts", target: "es2022" },
).code;

class Element {
  constructor(id = "", tagName = "div") {
    this.id = id;
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.dataset = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
    };
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.value = ({ kind: "tracking", rank: "week", withhold: "2" })[id] || "";
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  setAttributeNS(_namespace, name, value) { this.setAttribute(name, value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  replaceChildren(...children) { this.children = [...children]; }
  append(...children) { this.children.push(...children); }
  focus() {}
  click() { this.clicked = true; }
  querySelector() { return new Element("use"); }
}

function setupPopup(tabUrl = "https://www.youtube.com/feed/channels") {
  const elements = new Map();
  const tabs = ["subscribeTab", "playlistTab"].map((id, index) => {
    const tab = new Element(id, "button");
    tab.setAttribute("aria-controls", index === 0 ? "subscribePanel" : "playlistPanel");
    tab.setAttribute("aria-selected", String(index === 0));
    return tab;
  });
  for (const tab of tabs) elements.set(tab.id, tab);
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    querySelectorAll(selector) { return selector === '[role="tab"]' ? tabs : []; },
    createElement(tagName) { return new Element("", tagName); },
  };
  const storage = {
    backendUrl: "http://127.0.0.1:8123",
    token: "test-token",
    youtubeImportJobIds: [],
    youtubeFailedImportJobIds: [],
    youtubeRecentImportJobIds: [],
  };
  const messages = [];
  const storageChangeListeners = [];
  let fetchCalls = 0;
  let formDataInstances = 0;
  let requestedSources = 2;
  const jobId = "durable-import-job";
  const scanChannels = [
    { name: "First", url: "https://www.youtube.com/@first" },
    { name: "Second", url: "https://www.youtube.com/@second" },
  ];

  function sendResponse(message) {
    messages.push(message);
    if (message.type === "dreamedia:startYoutubeImport") {
      requestedSources = Array.isArray(message.sourcePayload?.sources)
        ? message.sourcePayload.sources.length
        : 1;
      return { ok: true, data: { jobId, status: "queued", requested: requestedSources } };
    }
    if (message.type === "dreamedia:youtubeImportStatus") {
      return {
        ok: true,
        data: {
          jobId, status: "completed", requested: requestedSources, processed: requestedSources,
          resolved: requestedSources, added: requestedSources, skipped: 0, failed: 0,
        },
      };
    }
    if (message.type === "dreamedia:updateYoutubeImportHistory") {
      if (message.recent) {
        storage.youtubeRecentImportJobIds = [
          message.jobId,
          ...storage.youtubeRecentImportJobIds.filter((id) => id !== message.jobId),
        ].slice(0, 10);
      }
      const ids = storage.youtubeImportJobIds;
      storage.youtubeImportJobIds = message.active
        ? [...new Set([...ids, message.jobId])]
        : ids.filter((id) => id !== message.jobId);
      return { ok: true, data: true };
    }
    if (message.type === "dreamedia:scanYoutubeSubscriptions") {
      return { ok: true, data: { complete: true, channels: scanChannels } };
    }
    if (message.type === "dreamedia:domainStatus") {
      return {
        ok: true,
        data: { host: "youtube.com", registered: { media: "yt", enabled: true } },
      };
    }
    if (message.type === "dreamedia:connectionStatus") {
      return { ok: true, data: { status: "connected", reason: "" } };
    }
    if (message.type === "dreamedia:cards") {
      return { ok: true, data: { cards: [] } };
    }
    if (message.type === "dreamedia:categories") {
      return { ok: true, data: { categories: [] } };
    }
    return { ok: true, data: {} };
  }

  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "test" }),
      getURL: (name) => `chrome-extension://test/${name}`,
      sendMessage(message, callback) {
        queueMicrotask(() => callback(sendResponse(message)));
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((name) => [name, storage[name]]));
        },
        async set(values) { Object.assign(storage, values); },
        async remove(name) { delete storage[name]; },
      },
      onChanged: { addListener(listener) { storageChangeListeners.push(listener); } },
    },
    tabs: {
      async query() { return [{ id: 5, url: tabUrl }]; },
      create() {},
    },
  };
  const context = vm.createContext({
    chrome,
    document,
    URL,
    JSON,
    fetch() { fetchCalls += 1; throw new Error("Unexpected HTTP request"); },
    FormData: class {
      constructor() { formDataInstances += 1; }
    },
    window: { confirm() { return true; } },
    setTimeout(callback, delay) {
      if (delay === 250) queueMicrotask(callback);
      return 1;
    },
    setInterval() { return 1; },
    clearTimeout() {},
    console,
  });
  vm.runInContext(popupSource, context, { filename: "popup.js" });
  return {
    elements,
    messages,
    storage,
    scanChannels,
    get fetchCalls() { return fetchCalls; },
    get formDataInstances() { return formDataInstances; },
  };
}

async function flushPopup() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("manual single-channel add uses one JSON batch and tracks its import job", async () => {
  const channelUrl = "https://www.youtube.com/@single";
  const popup = setupPopup(channelUrl);
  await flushPopup();
  await popup.elements.get("subscribe").listeners.get("click")();
  await flushPopup();

  const imports = popup.messages.filter((message) => message.type === "dreamedia:startYoutubeImport");
  assert.equal(imports.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(imports[0].sourcePayload)), {
    sources: [{ link: channelUrl }],
  });
  assert.equal(imports[0].kind, "tracking");
  assert.equal("links" in imports[0], false);
  assert.equal(popup.messages.filter((message) => message.type === "dreamedia:subscribe").length, 0);
  assert.equal(popup.fetchCalls, 0);
  assert.equal(popup.formDataInstances, 0);
  assert.ok(popup.messages.some((message) =>
    message.type === "dreamedia:updateYoutubeImportHistory" &&
    message.jobId === "durable-import-job" && message.recent === true,
  ));
  assert.ok(popup.storage.youtubeRecentImportJobIds.includes("durable-import-job"));
});

test("scanned channels are wrapped and sent via the same one-start WebSocket path", async () => {
  const popup = setupPopup();
  await flushPopup();

  await popup.elements.get("scanSubscriptions").listeners.get("click")();
  await popup.elements.get("subscribe").listeners.get("click")();
  await flushPopup();

  const imports = popup.messages.filter((message) => message.type === "dreamedia:startYoutubeImport");
  assert.equal(imports.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(imports[0].sourcePayload)), {
    sources: popup.scanChannels.map((channel) => ({ link: channel.url })),
  });
  assert.equal("links" in imports[0], false);
  assert.ok(popup.messages.some((message) =>
    message.type === "dreamedia:updateYoutubeImportHistory" &&
    message.jobId === "durable-import-job" && message.recent === true,
  ));
  assert.equal(popup.messages.filter((message) => message.type === "dreamedia:subscribe").length, 0);
  assert.equal(popup.fetchCalls, 0);
  assert.equal(popup.formDataInstances, 0);
});

test("popup has no user-selected JSON file chooser or file reader feature", () => {
  assert.doesNotMatch(
    popupHtml,
    /id="(?:jsonDropTarget|importJsonFile|jsonImportHelp)"|type="file"|Choose or drop a \.json file/i,
  );
  assert.doesNotMatch(
    popupSource,
    /jsonDropTarget|importJsonFile|jsonImportInFlight|file\.text\(\)/i,
  );
});

test("subscription scans reject playlist-only mode before starting a batch", async () => {
  const popup = setupPopup();
  await flushPopup();
  await popup.elements.get("scanSubscriptions").listeners.get("click")();
  popup.elements.get("kind").value = "playlist";
  await popup.elements.get("subscribe").listeners.get("click")();
  await flushPopup();

  assert.equal(popup.messages.filter((message) => message.type === "dreamedia:startYoutubeImport").length, 0);
  assert.equal(popup.messages.filter((message) => message.type === "dreamedia:subscribe").length, 0);
  assert.match(popup.elements.get("subStatus").textContent, /Choose a channel mode, not Playlist/);
});

test("background maps sourcePayload to one payload-based authenticated gqlWs mutation", async () => {
  let listener;
  const gqlCalls = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } },
    gqlWs: async (query, variables) => {
      gqlCalls.push({ query, variables });
      return {
        startYoutubeImport: {
          jobId: "router-job", status: "queued", requested: 1,
          processed: 0, resolved: 0, added: 0, skipped: 0, failed: 0,
        },
      };
    },
    bgErrorMessage: (error) => String(error),
  });
  vm.runInContext(routerSource, context, { filename: "60-message-router.js" });

  const sourcePayload = { sources: [{ link: "https://www.youtube.com/@one" }], note: "complete payload" };
  const response = await new Promise((resolve) => {
    listener({
      type: "dreamedia:startYoutubeImport",
      sourcePayload,
      kind: "tracking",
      words: null,
      rank: null,
      withhold: null,
      domain: null,
      subdomain: null,
    }, {}, resolve);
  });

  assert.equal(gqlCalls.length, 1);
  assert.match(gqlCalls[0].query, /startYoutubeImport\(payload: \$payload/);
  assert.deepEqual(JSON.parse(JSON.stringify(gqlCalls[0].variables)), {
    payload: sourcePayload,
    kind: "tracking",
    words: null,
    rank: null,
    withhold: null,
    domain: null,
    subdomain: null,
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.jobId, "router-job");
});

test("popup contains no multipart upload or REST import-status endpoint", () => {
  assert.doesNotMatch(popupSource, /\/extension\/sources\/(?:import|status)/);
  assert.doesNotMatch(popupSource, /pollJsonImportJob|sendHttp/);
});
