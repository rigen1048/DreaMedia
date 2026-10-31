import { useCallback } from "react";
import { api } from "../api";
import type { SubscribeInput, YtChannel, YtKind } from "../api";
import type { AfterAction } from "./shared";

type YoutubeActionOptions = {
  after: AfterAction;
  invalidate: () => Promise<void>;
};

export function useYoutubeActions({ after, invalidate }: YoutubeActionOptions) {
  const subscribeYoutube = useCallback(
    async (
      input: SubscribeInput,
      category?: { domain: string; subdomain: string | null },
    ): Promise<number> => {
      const result = await api.yt.subscribe(input);
      if (category?.domain) {
        await api.yt.assignChannel(result.channel_id, category.domain, category.subdomain);
      }
      await invalidate();
      return result.channel_id;
    },
    [invalidate],
  );

  return {
    subscribeYoutube,
    switchChannelMode: useCallback(
      (id: number, kind: YtKind, words?: string[], rank?: string) =>
        after(() => api.yt.switchMode(id, kind, words, rank)),
      [after],
    ),
    setChannelActive: useCallback(
      (id: number, active: boolean) => after(() => api.yt.setChannelActive(id, active)),
      [after],
    ),
    setChannelLabel: useCallback(
      (id: number, label: YtChannel["label"], reason?: string) =>
        after(() => api.yt.setChannelLabel(id, label, reason)),
      [after],
    ),
    assignChannel: useCallback(
      (id: number, domain: string, subdomain: string | null) =>
        after(() => api.yt.assignChannel(id, domain, subdomain)),
      [after],
    ),
    deleteChannel: useCallback((id: number) => after(() => api.yt.deleteChannel(id)), [after]),
    markVideosSeen: useCallback(
      (ids: number[], seen = true) => after(() => api.yt.markVideosSeen(ids, seen)),
      [after],
    ),
    setCategoryActive: useCallback(
      (domain: string, subdomain: string | null, active: boolean) =>
        after(() => api.yt.setCategoryActive(domain, subdomain, active)),
      [after],
    ),
    createCategory: useCallback(
      (domain: string, subdomain: string | null) =>
        after(() => api.yt.createCategory(domain, subdomain)),
      [after],
    ),
    renameCategory: useCallback(
      (domain: string, newName: string, subdomain: string | null) =>
        after(() => api.yt.renameCategory(domain, newName, subdomain)),
      [after],
    ),
    deleteCategory: useCallback(
      (domain: string, subdomain: string | null) =>
        after(() => api.yt.deleteCategory(domain, subdomain)),
      [after],
    ),
  };
}
