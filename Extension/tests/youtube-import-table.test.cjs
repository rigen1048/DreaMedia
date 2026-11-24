const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const distPage = path.join(__dirname, "..", "dist", "mv3", "imports.js");
const pageSource = fs.readFileSync(distPage, "utf8");

class Element {
  constructor(id = "", tagName = "div") {
    this.id = id;
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.value = "";
    this.className = "";
    this.parentElement = null;
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
}

function setupPage({ holdOtherStatus = false } = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new Element(id);
        if (id === "progressFill") element.parentElement = new Element("progressTrack");
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement(tagName) { return new Element("", tagName); },
  };
  const storage = {
    youtubeImportJobIds: ["job-123"],
    youtubeFailedImportJobIds: [],
    youtubeRecentImportJobIds: ["job-123", "job-456"],
  };
  const messages = [];
  let pendingOtherStatus;
  const otherJob = {
    jobId: "job-456", status: "completed", requested: 1, processed: 1,
    resolved: 1, added: 1, skipped: 0, failed: 0,
    items: [{ ordinal: 0, link: "https://www.youtube.com/@other", status: "added", error: null, retryable: false }],
  };
  let job = {
    jobId: "job-123", status: "running", requested: 3, processed: 2,
    resolved: 2, added: 1, skipped: 0, failed: 1,
    items: [
      { ordinal: 0, link: "https://www.youtube.com/@done", status: "added", error: null, retryable: false },
      { ordinal: 1, link: "https://www.youtube.com/@working", status: "resolving", error: null, retryable: false },
      { ordinal: 2, link: "https://www.youtube.com/@retry", status: "failed", error: "temporary failure", retryable: true },
    ],
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "dreamedia:youtubeImportStatus") {
          if (message.jobId === "job-456" && holdOtherStatus && !message.includeItems) {
            pendingOtherStatus = () => callback({ ok: true, data: otherJob });
            return;
          }
          queueMicrotask(() => callback({ ok: true, data: message.jobId === "retry-456"
            ? {
              jobId: "retry-456", status: "queued", requested: 1, processed: 0,
              resolved: 0, added: 0, skipped: 0, failed: 0,
              items: [{ ordinal: 0, link: "https://youtube.com/@retry", status: "queued", error: null, retryable: false }],
            }
            : message.jobId === "job-456" ? otherJob : job }));
        } else if (message.type === "dreamedia:retryYoutubeImport") {
          queueMicrotask(() => callback({ ok: true, data: {
            jobId: "retry-456", status: "queued", requested: 1,
            processed: 0, resolved: 0, added: 0, skipped: 0, failed: 0,
          } }));
        } else {
          queueMicrotask(() => callback({ ok: true, data: {} }));
        }
      },
    },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((name) => [name, storage[name]]));
        },
        async set(values) { Object.assign(storage, values); },
      },
    },
    tabs: {
      query(_options, callback) { callback([{ id: 9 }]); },
      remove() {},
    },
  };
  const context = vm.createContext({
    chrome, document, URL, console,
    setInterval() { return 1; },
  });
  vm.runInContext(pageSource, context, { filename: "imports.js" });
  return {
    elements, messages, storage,
    setJob(value) { job = value; },
    releaseOtherStatus() { pendingOtherStatus?.(); pendingOtherStatus = null; },
  };
}

async function flushPage() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("import table renders one row per channel and ticks completed items", async () => {
  const { elements } = setupPage();
  await flushPage();

  const rows = elements.get("itemRows").children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].children[1].children[0].children[0].textContent, "✓");
  assert.equal(rows[0].children[1].children[0].children[1].textContent, "Added");
  assert.equal(rows[1].children[1].children[0].children[1].textContent, "Resolving");
  assert.equal(rows[2].children[3].textContent, "temporary failure");
  assert.equal(elements.get("batchProgress").textContent, "2 / 3 processed");
  assert.equal(elements.get("retryFailed").disabled, true);
});

test("selecting another batch fetches its detailed channel rows", async () => {
  const page = setupPage();
  await flushPage();

  page.elements.get("jobSelect").listeners.get("change")({ target: { value: "job-456" } });
  await flushPage();

  const detailRequests = page.messages.filter((message) =>
    message.type === "dreamedia:youtubeImportStatus" && message.jobId === "job-456" && message.includeItems,
  );
  assert.equal(detailRequests.length, 1);
  assert.equal(page.elements.get("itemRows").children.length, 1);
  assert.equal(page.elements.get("itemRows").children[0].children[2].children[0].textContent, "https://www.youtube.com/@other");
});

test("batch selection during a compact request triggers a detailed follow-up", async () => {
  const page = setupPage({ holdOtherStatus: true });
  await flushPage();

  page.elements.get("jobSelect").listeners.get("change")({ target: { value: "job-456" } });
  page.releaseOtherStatus();
  await flushPage();

  const detailRequests = page.messages.filter((message) =>
    message.type === "dreamedia:youtubeImportStatus" && message.jobId === "job-456" && message.includeItems,
  );
  assert.equal(detailRequests.length, 1);
  assert.equal(page.elements.get("itemRows").children.length, 1);
});

test("finished batch enables retry and retry opens a new durable table batch", async () => {
  const page = setupPage();
  const { elements } = page;
  await flushPage();
  page.setJob({
    jobId: "job-123", status: "partial", requested: 3, processed: 3,
    resolved: 2, added: 1, skipped: 1, failed: 1,
    items: [
      { ordinal: 0, link: "https://www.youtube.com/@done", status: "added", error: null, retryable: false },
      { ordinal: 1, link: "https://www.youtube.com/@duplicate", status: "skipped", error: null, retryable: false },
      { ordinal: 2, link: "https://www.youtube.com/@retry", status: "failed", error: "temporary failure", retryable: true },
    ],
  });
  elements.get("refreshJobs").listeners.get("click")();
  await flushPage();

  assert.equal(elements.get("batchProgress").textContent, "3 / 3 processed");
  assert.equal(elements.get("itemRows").children[1].children[1].children[0].children[0].textContent, "✓");
  assert.match(elements.get("rowAnnouncement").textContent, /@duplicate: Already present/);
  const retry = elements.get("retryFailed");
  assert.equal(retry.disabled, false);
  retry.listeners.get("click")();
  await flushPage();

  assert.ok(page.messages.some((message) => message.type === "dreamedia:retryYoutubeImport" && message.jobId === "job-123"));
  assert.equal(elements.get("jobSelect").value, "retry-456");
  assert.equal(elements.get("itemRows").children.length, 1);
  assert.ok(Array.from(page.storage.youtubeImportJobIds).includes("retry-456"));
  assert.ok(Array.from(page.storage.youtubeRecentImportJobIds).includes("retry-456"));
});
