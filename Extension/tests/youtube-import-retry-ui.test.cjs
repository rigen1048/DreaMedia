const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupSource = fs.readFileSync(path.join(__dirname, "../shared/popup.js"), "utf8");

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

function setupPopup(initialStorage = {}) {
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
    ...initialStorage,
  };
  const messages = [];
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
          data: { complete: true, channels: [{ name: "Example Channel", url: "https://www.youtube.com/@example" }] },
        };
      case "dreamedia:startYoutubeImport":
        return { ok: true, data: { jobId: "original-job", requested: 1, status: "queued" } };
      case "dreamedia:youtubeImportStatus":
        if (message.jobId === "original-job") {
          return {
            ok: true,
            data: {
              jobId: "original-job", status: "partial", requested: 1, processed: 1,
              resolved: 0, added: 0, skipped: 0, failed: 1,
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
    tabs: { async query() { return [{ id: 5, url: "https://www.youtube.com/feed/channels" }]; } },
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
  return { document, elements, messages, storage };
}

async function flushPopup() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("popup displays a failed channel and retries it as a new durable job", async () => {
  const { document, elements, messages, storage } = setupPopup();
  await flushPopup();

  await elements.get("scanSubscriptions").listeners.get("click")();
  await elements.get("subscribe").listeners.get("click")();
  await flushPopup();

  const details = elements.get("failedImports");
  assert.equal(details.hidden, false);
  assert.equal(elements.get("failedImportSummary").textContent, "Failed channels (1)");
  const row = elements.get("failedImportList").children[0];
  const retryButton = row.children[0].children[1];
  assert.equal(retryButton.textContent, "Retry 1");
  assert.match(row.children[1].children[0].children[0].textContent, /@example/);

  retryButton.listeners.get("click")();
  await flushPopup();

  assert.ok(messages.some((message) => message.type === "dreamedia:retryYoutubeImport" && message.jobId === "original-job"));
  assert.deepEqual(Array.from(storage.youtubeFailedImportJobIds), []);
  assert.deepEqual(Array.from(storage.youtubeImportJobIds), ["retry-job"]);
});

test("popup restores the failed-channel list from stored job IDs after reopening", async () => {
  const { elements } = setupPopup({ youtubeFailedImportJobIds: ["original-job"] });
  await flushPopup();

  assert.equal(elements.get("failedImports").hidden, false);
  assert.equal(elements.get("failedImportSummary").textContent, "Failed channels (1)");
  assert.match(elements.get("failedImportList").children[0].children[1].children[0].children[0].textContent, /@example/);
});
