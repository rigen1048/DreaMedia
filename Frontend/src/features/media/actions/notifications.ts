import { useCallback } from "react";
import { api } from "../api";
import type { AfterAction } from "./shared";
import type { BellNotification, MediaNotification } from "../model/types";

export function useNotificationActions(after: AfterAction) {
  const markBellSeen = useCallback(
    (items: BellNotification[], seen = true) =>
      after(() =>
        Promise.all([
          api.notifications.markSeen(
            items.filter((item) => item.origin === "record").map((item) => item.backendId),
            seen,
          ),
          api.yt.markVideosSeen(
            items
              .filter((item) => item.origin === "feed" && item.source === "youtube")
              .map((item) => item.backendId),
            seen,
          ),
          api.ani.markEventsSeen(
            items
              .filter((item) => item.origin === "feed" && item.source === "ani")
              .map((item) => item.backendId),
            seen,
          ),
        ]),
      ),
    [after],
  );

  const markFeedSeen = useCallback(
    (items: MediaNotification[], seen = true) =>
      after(() =>
        Promise.all([
          api.yt.markVideosSeen(
            items.filter((item) => item.source === "youtube").map((item) => item.backendId),
            seen,
          ),
          api.ani.markEventsSeen(
            items.filter((item) => item.source === "ani").map((item) => item.backendId),
            seen,
          ),
        ]),
      ),
    [after],
  );

  return {
    markNotificationSeen: useCallback(
      (ids: number[], seen = true) => after(() => api.notifications.markSeen(ids, seen)),
      [after],
    ),
    markBellSeen,
    markFeedSeen,
  };
}
