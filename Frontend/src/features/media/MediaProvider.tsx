import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BackendError } from "../../shared/api/http";
import { mediaQueryKeys } from "../../shared/query/mediaKeys";
import { api } from "./api";
import { useMediaActions } from "./useMediaActions";
import {
  selectAnime,
  selectBellNotifications,
  selectCategories,
  selectChannels,
  selectDomains,
  selectNotifications,
  selectYoutubeTracks,
} from "./model/selectors";
import { emptyMediaBundle, fetchMediaBundle } from "./query/mediaBundle";
import type { MediaContextValue } from "./types";

const MediaContext = createContext<MediaContextValue | null>(null);

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Backend request failed.";
}

type MediaProviderProps = {
  children: ReactNode;
};

export function MediaProvider({ children }: MediaProviderProps) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: mediaQueryKeys.all,
    queryFn: fetchMediaBundle,
    refetchInterval: 30_000,
  });
  const raw = query.data ?? emptyMediaBundle;
  const authenticationError = query.error instanceof BackendError && query.error.status === 401;
  const authStatus: MediaContextValue["authStatus"] = query.isLoading
    ? "loading"
    : authenticationError
      ? "unauthenticated"
      : query.isError
        ? "error"
        : "ready";

  const refresh = useCallback(async (): Promise<void> => {
    await query.refetch();
  }, [query]);

  const invalidate = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: mediaQueryKeys.all });
    await query.refetch();
  }, [query, queryClient]);

  const reset = useCallback((): void => {
    queryClient.setQueryData(mediaQueryKeys.all, emptyMediaBundle);
    queryClient.removeQueries({ queryKey: mediaQueryKeys.all });
  }, [queryClient]);

  const actions = useMediaActions({ invalidate, reset });
  const channels = useMemo(() => selectChannels(raw.channels), [raw.channels]);
  const domains = useMemo(() => selectDomains(raw.categories), [raw.categories]);
  const categories = useMemo(() => selectCategories(raw.categories), [raw.categories]);
  const anime = useMemo(() => selectAnime(raw.entries), [raw.entries]);
  const youtubeTracks = useMemo(
    () => selectYoutubeTracks(channels, raw.videos),
    [channels, raw.videos],
  );
  const notifications = useMemo(
    () => selectNotifications(raw, channels, anime),
    [anime, channels, raw],
  );
  const bellNotifications = useMemo(
    () => selectBellNotifications(raw.bell, notifications),
    [notifications, raw.bell],
  );
  const username = null;
  const authError = authenticationError ? null : query.isError ? asMessage(query.error) : null;
  const syncError = authStatus === "ready" && query.isError ? asMessage(query.error) : null;

  const value = useMemo<MediaContextValue>(
    () => ({
      authStatus,
      authError,
      syncError,
      username,
      refresh,
      ...actions,
      notifications,
      bellNotifications,
      channels,
      categories,
      domains,
      youtubeTracks,
      anime,
    }),
    [
      actions,
      anime,
      authError,
      authStatus,
      bellNotifications,
      categories,
      channels,
      domains,
      notifications,
      refresh,
      syncError,
      username,
      youtubeTracks,
    ],
  );

  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}

export function useMedia(): MediaContextValue {
  const value = useContext(MediaContext);
  if (!value) {
    throw new Error("useMedia must be used inside MediaProvider");
  }
  return value;
}
