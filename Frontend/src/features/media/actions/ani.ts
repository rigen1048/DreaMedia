import { useCallback } from "react";
import { api } from "../api";
import type { AniEntry, AniEntryPatch } from "../api";
import type { AnimeTrack } from "../model/types";
import type { AfterAction } from "./shared";

export function useAniActions(after: AfterAction) {
  return {
    trackAnime: useCallback(
      (title: string, list: AniEntry["list"]) => after(() => api.ani.track(title, list)),
      [after],
    ),
    updateAnime: useCallback(
      (id: number, patch: AniEntryPatch) => after(() => api.ani.updateEntry(id, patch)),
      [after],
    ),
    setSeasonWatched: useCallback(
      (id: number, seasonNo: number, watched: boolean) =>
        after(() => api.ani.setSeasonWatched(id, seasonNo, watched)),
      [after],
    ),
    setAnimeCursor: useCallback(
      (id: number, season: number, episode: number | null, seconds: number | null) =>
        after(() => api.ani.setCursor(id, season, episode, seconds)),
      [after],
    ),
    markAnimeRange: useCallback(
      (id: number, from: number, to: number) => after(() => api.ani.markRange(id, from, to)),
      [after],
    ),
    finishAnime: useCallback(
      (entry: AnimeTrack) => after(() => api.ani.markAllWatched(entry.backendId)),
      [after],
    ),
    deleteAnime: useCallback((id: number) => after(() => api.ani.deleteEntry(id)), [after]),
  };
}
