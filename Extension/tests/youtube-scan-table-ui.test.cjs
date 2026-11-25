const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageSource = fs.readFileSync(
  path.join(__dirname, "..", "dist", "mv3", "scan-table.js"),
  "utf8",
);

class Element {
  constructor(id = "", tagName = "div") {
    this.id = id;
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.hidden = false;
    this.textContent = "";
    this.className = "";
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
}

function setupPage() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement(tagName) { return new Element("", tagName); },
  };
  const storage = {
    youtubeScanChannels: [{
      url: "https://www.youtube.com/@channel",
      name: "Channel",
      status: "added",
      result: "Added to DreaMedia",
      scannedAt: 1,
    }],
    importTableTabId: 77,
    scanTableTabId: 88,
  };
  const removedTabs = [];
  const chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const names = Array.isArray(keys) ? keys : [keys];
          const result = Object.fromEntries(names.map((name) => [name, storage[name]]));
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result);
        },
        remove(key) { delete storage[key]; return Promise.resolve(); },
      },
    },
    tabs: {
      getCurrent(callback) { callback({ id: 10 }); },
      remove(tabId) { removedTabs.push(tabId); },
    },
  };
  const context = vm.createContext({
    chrome,
    document,
    window: { confirm() { return true; } },
  });
  vm.runInContext(pageSource, context, { filename: "scan-table.js" });
  return { elements, storage, removedTabs };
}

async function flushPage() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("scan results become visible after loading saved channels", async () => {
  const page = setupPage();
  await flushPage();

  assert.equal(page.elements.get("scanView").hidden, false);
  assert.equal(page.elements.get("pageMessage").hidden, true);
  assert.equal(page.elements.get("itemRows").children.length, 1);
  assert.equal(page.elements.get("itemRows").children[0].children[1].children[0].textContent, "Channel");
});

test("closing the scan table closes the current scan tab without targeting the import tab", async () => {
  const page = setupPage();
  await flushPage();
  page.elements.get("closePage").listeners.get("click")();
  await flushPage();

  assert.deepEqual(page.removedTabs, [10]);
  assert.equal(page.storage.importTableTabId, 77);
  assert.equal(page.storage.scanTableTabId, 88);
});
