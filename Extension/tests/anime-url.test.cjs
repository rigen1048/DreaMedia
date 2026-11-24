const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../dist/mv3/modules/anime-url.js"),
  "utf8",
);
const sandbox = { window: {}, URL, URLSearchParams };
vm.runInNewContext(source, sandbox, { filename: "anime-url.js" });
const parse = (url) => JSON.parse(JSON.stringify(sandbox.window.DreaMediaAnimeUrl.parse(url)));

test("parses the supplied anime watch URL shapes without treating IDs as episodes", () => {
  const cases = [
    ["https://site.test/watch/one-piece-81553/ep-29", 29, null, "path:episode-marker"],
    ["https://site.test/watch/one-piece?ep=185&type=sub", 185, null, "query:ep"],
    ["https://site.test/episode?anime=63801&ep_num=2", 2, null, "query:ep_num"],
    ["https://site.test/watch/one-piece-21/518", 518, null, "path:trailing-number"],
    ["https://site.test/watch/21/2?audio=sub", 2, null, "path:trailing-number"],
  ];
  for (const [url, episode, season, source] of cases) {
    const result = parse(url);
    assert.equal(result.episode, episode, url);
    assert.equal(result.season, season, url);
    assert.equal(result.source, source, url);
  }
});

test("recognizes season and episode markers while preserving episode zero as invalid", () => {
  assert.deepEqual(
    parse("https://site.test/watch/season-02/ep-005"),
    { season: 2, episode: 5, source: "path:episode-marker", confidence: "high" },
  );
  assert.equal(parse("https://site.test/watch/show?ep=0").episode, null);
});

test("does not infer an episode from unrelated IDs or conflicting duplicate query keys", () => {
  assert.equal(parse("https://site.test/anime/63801").episode, null);
  assert.equal(parse("https://site.test/watch/63801").episode, null);
  assert.equal(parse("https://site.test/episode?anime=63801").episode, null);
  assert.equal(parse("https://site.test/watch/show?ep=2&ep=3").episode, null);
  assert.equal(parse("https://site.test/watch/show?ep=2&ep=2").episode, null);
  assert.equal(parse("https://site.test/watch/21/2?ep=2&ep=3").episode, null);
  assert.equal(parse("https://site.test/watch/show?anime=63801").source, "");
  assert.deepEqual(
    parse("https://site.test/watch/show?season=2&season=3&ep=5"),
    { season: null, episode: 5, source: "query:ep", confidence: "high" },
  );
});
