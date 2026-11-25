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

function setupPopup() {
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
  let jsonParseCalls = 0;
  const jobId = "durable-import-job";
  const scanChannels = [
    { name: "First", url: "https://www.youtube.com/@first" },
    { name: "Second", url: "https://www.youtube.com/@second" },
  ];

  function sendResponse(message) {
    messages.push(message);
    if (message.type === "dreamedia:startYoutubeImport") {
      return { ok: true, data: { jobId, status: "queued", requested: 2 } };
    }
    if (message.type === "dreamedia:youtubeImportStatus") {
      return {
        ok: true,
        data: {
          jobId, status: "completed", requested: 2, processed: 2,
          resolved: 2, added: 2, skipped: 0, failed: 0,
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
      async query() { return [{ id: 5, url: "https://www.youtube.com/feed/channels" }]; },
      create() {},
    },
  };
  const context = vm.createContext({
    chrome,
    document,
    URL,
    JSON: {
      parse(text) { jsonParseCalls += 1; return JSON.parse(text); },
      stringify: JSON.stringify,
    },
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
    get jsonParseCalls() { return jsonParseCalls; },
  };
}

async function flushPopup() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("one JSON file is parsed once and sent whole in one WebSocket import, then its job enters history", async () => {
  const popup = setupPopup();
  await flushPopup();
  for (const id of ["words", "domain", "subdomain"]) {
    popup.elements.set(id, new Element(id));
  }
  popup.elements.get("kind").value = "wordscan";
  popup.elements.get("words").value = "trailer, live";
  popup.elements.get("domain").value = "Technology";
  popup.elements.get("subdomain").value = "Video";

  const documentValue = {
    sources: [{ link: "https://www.youtube.com/@one", title: "One" }],
    metadata: { creator: "fixture", version: 7 },
  };
  let textReads = 0;
  const file = {
    name: "sources.json",
    async text() { textReads += 1; return JSON.stringify(documentValue); },
  };
  const input = popup.elements.get("importJsonFile");
  input.files = [file];
  await input.listeners.get("change")({ target: input });
  await flushPopup();

  const imports = popup.messages.filter((message) => message.type === "dreamedia:startYoutubeImport");
  assert.equal(textReads, 1);
  assert.equal(popup.jsonParseCalls, 1);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].kind, "wordscan");
  assert.deepEqual(Array.from(imports[0].words), ["trailer", "live"]);
  assert.equal(imports[0].domain, "Technology");
  assert.equal(imports[0].subdomain, "Video");
  assert.deepEqual(JSON.parse(JSON.stringify(imports[0].sourcePayload)), documentValue);
  assert.equal("links" in imports[0], false);
  assert.equal(popup.fetchCalls, 0);
  assert.equal(popup.formDataInstances, 0);
  assert.ok(popup.messages.some((message) =>
    message.type === "dreamedia:updateYoutubeImportHistory" &&
    message.jobId === "durable-import-job" && message.recent === true,
  ));
  assert.ok(popup.storage.youtubeRecentImportJobIds.includes("durable-import-job"));
  assert.equal(input.value, "");
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
  assert.equal(popup.fetchCalls, 0);
  assert.equal(popup.formDataInstances, 0);
});

test("accessible drop target opens the file picker and imports dropped JSON", async () => {
  const popup = setupPopup();
  await flushPopup();
  const target = popup.elements.get("jsonDropTarget");
  const input = popup.elements.get("importJsonFile");
  target.listeners.get("click")();
  assert.equal(input.clicked, true);

  let prevented = false;
  let textReads = 0;
  target.listeners.get("drop")({
    preventDefault() { prevented = true; },
    dataTransfer: {
      files: [{
        name: "dropped.json",
        async text() { textReads += 1; return '{"sources":[{"link":"https://youtube.com/@dropped"}]}'; },
      }],
    },
  });
  await flushPopup();

  assert.equal(prevented, true);
  assert.equal(textReads, 1);
  assert.equal(popup.messages.filter((message) => message.type === "dreamedia:startYoutubeImport").length, 1);
  assert.match(popupHtml, /id="jsonDropTarget"[^>]*aria-describedby="jsonImportHelp"/);
  assert.match(popupHtml, /id="importJsonFile" type="file" accept="application\/json,\.json" hidden/);
  assert.doesNotMatch(popupHtml, /Import \.json/);
});

test("JSON source batches reject the playlist-only mode before sending", async () => {
  const popup = setupPopup();
  await flushPopup();
  popup.elements.get("kind").value = "playlist";
  let textReads = 0;
  const input = popup.elements.get("importJsonFile");
  input.files = [{
    name: "sources.json",
    async text() { textReads += 1; return '{"link":"https://youtube.com/@one"}'; },
  }];

  await input.listeners.get("change")({ target: input });
  await flushPopup();

  assert.equal(textReads, 0);
  assert.equal(popup.messages.filter((message) => message.type === "dreamedia:startYoutubeImport").length, 0);
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
  assert.doesNotMatch(popupSource, /Import \.json/);
});
