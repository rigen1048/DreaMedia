const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../dist/mv3/modules/youtube-import.js"),
  "utf8",
);

async function scan(links, guideLinks = [], pageUrl = "https://www.youtube.com/feed/channels") {
  let listener;
  let rowSelector = "";
  const makeRow = (hrefs) => {
    const row = {
      querySelectorAll(selector) {
        assert.equal(selector, "a[href]");
        return hrefs.map((href) => ({
          textContent: "",
          getAttribute(name) { return name === "href" ? href : null; },
          closest(selector) {
            assert.equal(selector, rowSelector);
            return row;
          },
        }));
      },
      querySelector() { return null; },
    };
    return row;
  };
  const channelRow = makeRow(links);
  const guideRow = makeRow(guideLinks);
  const scroller = { scrollTop: 0, scrollHeight: 100 };
  const context = vm.createContext({
    window: { scrollTo() {} },
    URL,
    location: new URL(pageUrl),
    document: {
      scrollingElement: scroller,
      documentElement: scroller,
      querySelectorAll(selector) {
        rowSelector = selector;
        return selector.includes("ytd-guide-entry-renderer")
          ? [channelRow, guideRow]
          : [channelRow];
      },
    },
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; },
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } },
    setTimeout(callback) { queueMicrotask(callback); },
  });
  vm.runInNewContext(source, context, { filename: "youtube-import.js" });
  const result = await new Promise((resolve) => {
    listener({ type: "dreamedia:scanYoutubeSubscriptions" }, {}, resolve);
  });
  return { result, rowSelector };
}

test("subscription scan excludes guide navigation, Music subdomain, and non-channel URLs", async () => {
  const { result, rowSelector } = await scan([
    "https://www.youtube.com/@SubscribedChannel",
    "https://youtube.com/@subscribedchannel/",
    "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa",
    "https://www.youtube.com/feed/channels",
    "https://www.youtube.com/playlist?list=PL123",
  ], ["https://www.youtube.com/@my-own-channel"]);

  assert.equal(result.ok, true);
  assert.equal(rowSelector.includes("ytd-guide-entry-renderer"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.channels.map((channel) => channel.url))),
    ["https://www.youtube.com/@SubscribedChannel"],
  );
  assert.equal(result.complete, true);
});

test("scanner selector only reads subscription channel cards, not guide entries", async () => {
  const { rowSelector } = await scan(
    ["https://www.youtube.com/@channel"],
    ["https://www.youtube.com/@my-own-channel"],
  );
  assert.equal(rowSelector, "ytd-channel-renderer, ytd-grid-channel-renderer");
});

test("subscription scan refuses the Music subdomain page itself", async () => {
  const { result } = await scan(
    ["https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"],
    [],
    "https://music.youtube.com/feed/channels",
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Open YouTube's channel subscriptions page/);
});
