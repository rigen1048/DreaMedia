const YOUTUBE_IMPORT_ACTIVE_KEY = "youtubeImportJobIds";
const YOUTUBE_IMPORT_FAILED_KEY = "youtubeFailedImportJobIds";
const YOUTUBE_IMPORT_RECENT_KEY = "youtubeRecentImportJobIds";
const YOUTUBE_IMPORT_HIDDEN_KEY = "youtubeHiddenImportJobIds";
const YOUTUBE_IMPORT_RECENT_LIMIT = 10;
const YOUTUBE_IMPORT_HIDDEN_LIMIT = 200;
const YOUTUBE_IMPORT_HISTORY_KEYS = [
  YOUTUBE_IMPORT_ACTIVE_KEY,
  YOUTUBE_IMPORT_FAILED_KEY,
  YOUTUBE_IMPORT_RECENT_KEY,
  YOUTUBE_IMPORT_HIDDEN_KEY,
];

let youtubeImportHistoryWriteQueue: Promise<void> = Promise.resolve();

function serializeYoutubeImportHistoryWrite<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = youtubeImportHistoryWriteQueue.then(operation, operation);
  youtubeImportHistoryWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function youtubeImportHistoryIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

function updateYoutubeImportMembership(ids: string[], jobId: string, include: boolean): string[] {
  return include
    ? [...new Set([...ids, jobId])]
    : ids.filter((id) => id !== jobId);
}

async function updateYoutubeImportHistory(
  jobId: string,
  active: boolean,
  failed: boolean,
  promoteRecent: boolean,
): Promise<boolean> {
  return serializeYoutubeImportHistoryWrite(async () => {
    const stored = await chrome.storage.local.get(YOUTUBE_IMPORT_HISTORY_KEYS);
    const activeIds = youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_ACTIVE_KEY]);
    const failedIds = youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_FAILED_KEY]);
    const recentIds = youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_RECENT_KEY]);
    const hiddenIds = youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_HIDDEN_KEY]);

    if (hiddenIds.includes(jobId)) {
      await chrome.storage.local.set({
        [YOUTUBE_IMPORT_ACTIVE_KEY]: updateYoutubeImportMembership(activeIds, jobId, false),
        [YOUTUBE_IMPORT_FAILED_KEY]: updateYoutubeImportMembership(failedIds, jobId, false),
        [YOUTUBE_IMPORT_RECENT_KEY]: updateYoutubeImportMembership(recentIds, jobId, false),
        [YOUTUBE_IMPORT_HIDDEN_KEY]: hiddenIds.slice(-YOUTUBE_IMPORT_HIDDEN_LIMIT),
      });
      return false;
    }

    const recent = promoteRecent
      ? [jobId, ...recentIds.filter((id) => id !== jobId)].slice(0, YOUTUBE_IMPORT_RECENT_LIMIT)
      : recentIds;
    await chrome.storage.local.set({
      [YOUTUBE_IMPORT_ACTIVE_KEY]: updateYoutubeImportMembership(activeIds, jobId, active),
      [YOUTUBE_IMPORT_FAILED_KEY]: updateYoutubeImportMembership(failedIds, jobId, failed),
      [YOUTUBE_IMPORT_RECENT_KEY]: recent,
      [YOUTUBE_IMPORT_HIDDEN_KEY]: hiddenIds.slice(-YOUTUBE_IMPORT_HIDDEN_LIMIT),
    });
    return true;
  });
}

async function hideYoutubeImportHistory(jobId: string): Promise<void> {
  await serializeYoutubeImportHistoryWrite(async () => {
    const stored = await chrome.storage.local.get(YOUTUBE_IMPORT_HISTORY_KEYS);
    const hiddenIds = youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_HIDDEN_KEY]);
    await chrome.storage.local.set({
      [YOUTUBE_IMPORT_ACTIVE_KEY]: updateYoutubeImportMembership(
        youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_ACTIVE_KEY]),
        jobId,
        false,
      ),
      [YOUTUBE_IMPORT_FAILED_KEY]: updateYoutubeImportMembership(
        youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_FAILED_KEY]),
        jobId,
        false,
      ),
      [YOUTUBE_IMPORT_RECENT_KEY]: updateYoutubeImportMembership(
        youtubeImportHistoryIds(stored[YOUTUBE_IMPORT_RECENT_KEY]),
        jobId,
        false,
      ),
      [YOUTUBE_IMPORT_HIDDEN_KEY]: [...new Set([...hiddenIds, jobId])].slice(
        -YOUTUBE_IMPORT_HIDDEN_LIMIT,
      ),
    });
  });
}
