const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

const helperPath = path.join(__dirname, "..", "shared", "background", "55-import-history.ts");
const helperSource = fs.readFileSync(helperPath, "utf8");
const helperCode = esbuild.transformSync(helperSource, { loader: "ts", target: "es2022" }).code;

function setupHistoryStore() {
  const storage = {
    youtubeImportJobIds: ["delete-one", "delete-two"],
    youtubeFailedImportJobIds: ["delete-one"],
    youtubeRecentImportJobIds: ["delete-one", "delete-two"],
    youtubeHiddenImportJobIds: [],
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const snapshot = Object.fromEntries(keys.map((key) => [key, storage[key]]));
          await new Promise((resolve) => setTimeout(resolve, 2));
          return snapshot;
        },
        async set(values) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          Object.assign(storage, values);
        },
      },
    },
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(helperCode, context, { filename: "55-import-history.js" });
  return { context, storage };
}

test("serializes concurrent cross-context deletions and a new-job update without losing history", async () => {
  const { context, storage } = setupHistoryStore();

  await Promise.all([
    context.hideYoutubeImportHistory("delete-one"),
    context.hideYoutubeImportHistory("delete-two"),
    context.updateYoutubeImportHistory("new-job", true, false, true),
  ]);

  assert.deepEqual([...storage.youtubeHiddenImportJobIds].sort(), ["delete-one", "delete-two"]);
  assert.deepEqual(Array.from(storage.youtubeImportJobIds), ["new-job"]);
  assert.deepEqual(Array.from(storage.youtubeFailedImportJobIds), []);
  assert.deepEqual(Array.from(storage.youtubeRecentImportJobIds), ["new-job"]);

  await Promise.all([
    context.hideYoutubeImportHistory("deleted-during-poll"),
    context.updateYoutubeImportHistory("deleted-during-poll", true, true, true),
  ]);
  assert.ok(storage.youtubeHiddenImportJobIds.includes("deleted-during-poll"));
  assert.ok(!storage.youtubeImportJobIds.includes("deleted-during-poll"));
  assert.ok(!storage.youtubeFailedImportJobIds.includes("deleted-during-poll"));
  assert.ok(!storage.youtubeRecentImportJobIds.includes("deleted-during-poll"));
});


test("bounds deleted-job tombstones while keeping the newest deletion", async () => {
  const { context, storage } = setupHistoryStore();
  storage.youtubeHiddenImportJobIds = Array.from(
    { length: 250 },
    (_, index) => `old-job-${index}`,
  );

  await context.hideYoutubeImportHistory("latest-deletion");

  assert.equal(storage.youtubeHiddenImportJobIds.length, 200);
  assert.equal(storage.youtubeHiddenImportJobIds[0], "old-job-51");
  assert.ok(storage.youtubeHiddenImportJobIds.includes("latest-deletion"));
  assert.ok(!storage.youtubeHiddenImportJobIds.includes("old-job-0"));
});
