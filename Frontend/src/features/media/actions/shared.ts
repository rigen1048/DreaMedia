import { useCallback } from "react";

export type AfterAction = (operation: () => Promise<unknown>) => Promise<void>;

export function useAfterAction(invalidate: () => Promise<void>): AfterAction {
  return useCallback(
    async (operation: () => Promise<unknown>): Promise<void> => {
      await operation();
      await invalidate();
    },
    [invalidate],
  );
}
