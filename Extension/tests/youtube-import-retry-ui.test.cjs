const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupSource = fs.readFileSync(path.join(__dirname, "../dist/mv3/popup.js"), "utf8");

class Element {
  constructor(id = "", tagName = "div") {
    this.id = id;
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.dataset = {};
    this.classList = { toggle() {} };
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.value = ({ kind: "tracking", rank: "week", withhold: "2" })[id] || "";
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  replaceChildren(...children) { this.children = [...children]; }
  append(...children) { this.children.push(...children); }
  focus() {}
  querySelector() { return new Element("use"); }
}

function setupPopup(initialStorage = {}, firstJobStatus = "partial") {
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
    ...initialStorage,
  };
  const messages = [];
  const openedUrls = [];
  const sendResponse = (message) => {
    messages.push(message);
    switch (message.type) {
      case "dreamedia:connectionStatus":
        return { ok: true, data: { status: "connected", reason: "" } };
      case "dreamedia:refreshDomains":
        return { ok: true };
      case "dreamedia:domainStatus":
        return { ok: true, host: "youtube.com", registered: { media: "yt", enabled: true } };
      case "dreamedia:cards":
        return { ok: true, data: { cards: [] } };
      case "dreamedia:categories":
        return { ok: true, data: { categories: [] } };
      case "dreamedia:scanYoutubeSubscriptions":
        return {
          ok: true,
          data: { complete: true, channels: [
            { name: "Example Channel", url: "https://www.youtube.com/@example" },
            { name: "Second Channel", url: "https://www.youtube.com/@second" },
          ] },
        };
      case "dreamedia:startYoutubeImport":
        return { ok: true, data: { jobId: "original-job", requested: 2, status: "queued" } };
      case "dreamedia:youtubeImportStatus":
        if (message.jobId === "original-job") {
          return {
            ok: true,
            data: {
              jobId: "original-job", status: firstJobStatus, requested: 2,
              processed: firstJobStatus === "running" ? 1 : 2,
              resolved: 1, added: 0, skipped: 0, failed: 1,
              failedItems: [{
                link: "https://www.youtube.com/@example",
                error: "https://www.youtube.com/@example: temporary resolver failure",
                retryable: true,
              }],
            },
          };
        }
        return {
          ok: true,
          data: { jobId: message.jobId, status: "queued", requested: 1, processed: 0, failed: 0, failedItems: [] },
        };
      case "dreamedia:retryYoutubeImport":
        return { ok: true, data: { jobId: "retry-job", requested: 1, status: "queued" } };
      case "dreamedia:trackingStatus":
        return { ok: true, data: null };
      default:
        return { ok: true, data: {} };
    }
  };
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "test" }),
      getURL: (name) => `chrome-extension://test/${name}`,
      sendMessage(message, callback) { queueMicrotask(() => callback(sendResponse(message))); },
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
    },
    tabs: {
      async query() { return [{ id: 5, url: "https://www.youtube.com/feed/channels" }]; },
      create({ url }) { openedUrls.push(url); },
    },
  };
  const context = vm.createContext({
    chrome,
    document,
    URL,
    setTimeout() { return 1; },
    setInterval() { return 1; },
    clearTimeout() {},
    console,
  });
  vm.runInContext(popupSource, context, { filename: "popup.js" });
  return { document, elements, messages, openedUrls, storage };
}

async function flushPopup() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("popup opens the import table when a batch finishes with failures", async () => {
  const { elements, openedUrls, storage } = setupPopup();
  await flushPopup();

  await elements.get("scanSubscriptions").listeners.get("click")();
  await elements.get("subscribe").listeners.get("click")();
  await flushPopup();

  const tableButton = elements.get("openImportTable");
  assert.equal(tableButton.hidden, false);
  assert.equal(elements.get("importTableMeta").textContent, "1 with failures");
  tableButton.listeners.get("click")();
  assert.deepEqual(openedUrls, ["chrome-extension://test/imports.html"]);
  assert.deepEqual(Array.from(storage.youtubeFailedImportJobIds), ["original-job"]);
  assert.deepEqual(Array.from(storage.youtubeRecentImportJobIds), ["original-job"]);
});

test("popup restores the import-table action from stored job IDs", async () => {
  const { elements } = setupPopup({ youtubeFailedImportJobIds: ["original-job"] });
  await flushPopup();

  assert.equal(elements.get("openImportTable").hidden, false);
  assert.equal(elements.get("importTableMeta").textContent, "1 with failures");
});

test("popup offers the import table while a batch is importing without storing it as a failure", async () => {
  const { elements, storage } = setupPopup({}, "running");
  await flushPopup();
  await elements.get("scanSubscriptions").listeners.get("click")();
  await elements.get("subscribe").listeners.get("click")();
  await flushPopup();

  assert.match(elements.get("importStatus").textContent, /Importing/);
  assert.equal(elements.get("openImportTable").hidden, false);
  assert.equal(elements.get("importTableMeta").textContent, "1 active");
  assert.ok(Array.from(storage.youtubeImportJobIds).includes("original-job"));
  assert.ok(!Array.from(storage.youtubeFailedImportJobIds).includes("original-job"));
});
