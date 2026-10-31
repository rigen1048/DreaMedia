import { useCallback } from "react";
import { api } from "../api";
import type { AfterAction } from "./shared";
import type { BellNotification } from "../model/types";

export function useNotificationActions(after: AfterAction) {
  const markBellSeen = useCallback(
    (items: BellNotification[], seen = true) =>
      after(() =>
        api.notifications.markSeen(
          items.map((item) => item.backendId),
          seen,
        ),
      ),
    [after],
  );

  return { markBellSeen };
}
