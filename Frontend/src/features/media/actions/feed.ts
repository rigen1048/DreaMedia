import { useCallback } from "react";
import { api } from "../api";
import type { AfterAction } from "./shared";
import type { MediaNotification } from "../model/types";

export function useFeedActions(after: AfterAction) {
  const markVideosSeen = useCallback(
    (ids: number[], seen = true) => after(() => api.feed.markYoutubeSeen(ids, seen)),
    [after],
  );

  const markAnimeEventsSeen = useCallback(
    (ids: number[], seen = true) => after(() => api.feed.markAniEventsSeen(ids, seen)),
    [after],
  );

  const markFeedSeen = useCallback(
    (items: MediaNotification[], seen = true) => {
      const videos = items
        .filter((item) => item.source === "youtube")
        .map((item) => item.backendId);
      const events = items.filter((item) => item.source === "ani").map((item) => item.backendId);
      return after(() =>
        Promise.all([
          api.feed.markYoutubeSeen(videos, seen),
          api.feed.markAniEventsSeen(events, seen),
        ]),
      );
    },
    [after],
  );

  return { markVideosSeen, markAnimeEventsSeen, markFeedSeen };
}
