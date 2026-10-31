import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BackendError } from "../../shared/api/http";
import { mediaQueryKeys } from "../../shared/query/mediaKeys";
import { useMediaActions } from "./useMediaActions";
import {
  emptyFeedBundle,
  emptyManagementBundle,
  fetchBackendMessages,
  fetchFeedBundle,
  fetchManagementBundle,
} from "./query/mediaQueries";
import {
  selectAnime,
  selectBellNotifications,
  selectCategories,
  selectChannels,
  selectDomains,
  selectNotifications,
  selectYoutubeTracks,
} from "./model/selectors";
import type { MediaContextValue } from "./types";

const MediaContext = createContext<MediaContextValue | null>(null);

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Backend request failed.";
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof BackendError && error.status === 401;
}

type MediaProviderProps = {
  children: ReactNode;
};

export function MediaProvider({ children }: MediaProviderProps) {
  const queryClient = useQueryClient();
  const feedQuery = useQuery({
    queryKey: mediaQueryKeys.feed(),
    queryFn: fetchFeedBundle,
    refetchInterval: 30_000,
    retry: false,
  });
  const managementQuery = useQuery({
    queryKey: mediaQueryKeys.management(),
    queryFn: fetchManagementBundle,
    refetchInterval: 60_000,
    retry: false,
  });
  const messagesQuery = useQuery({
    queryKey: mediaQueryKeys.messages(),
    queryFn: fetchBackendMessages,
    refetchInterval: 30_000,
    retry: false,
  });

  const errors = [feedQuery.error, managementQuery.error, messagesQuery.error];
  const firstError = errors.find((error): error is Error => error instanceof Error) ?? null;
  const hasUnauthorizedError = errors.some(isUnauthorized);
  const hasData =
    feedQuery.data !== undefined ||
    managementQuery.data !== undefined ||
    messagesQuery.data !== undefined;
  const isLoading = feedQuery.isPending || managementQuery.isPending || messagesQuery.isPending;
  const hasError = firstError !== null;

  const authStatus: MediaContextValue["authStatus"] = hasUnauthorizedError
    ? "unauthenticated"
    : !hasData && isLoading
      ? "loading"
      : !hasData && hasError
        ? "error"
        : "ready";

  const refetchFeed = feedQuery.refetch;
  const refetchManagement = managementQuery.refetch;
  const refetchMessages = messagesQuery.refetch;
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refetchFeed(), refetchManagement(), refetchMessages()]);
  }, [refetchFeed, refetchManagement, refetchMessages]);

  const invalidate = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: mediaQueryKeys.all });
  }, [queryClient]);

  const reset = useCallback((): void => {
    queryClient.removeQueries({ queryKey: mediaQueryKeys.all });
  }, [queryClient]);

  const actions = useMediaActions({ invalidate, reset });
  const feed = feedQuery.data ?? emptyFeedBundle;
  const management = managementQuery.data ?? emptyManagementBundle;
  const messages = messagesQuery.data ?? [];
  const channels = useMemo(() => selectChannels(feed.channels), [feed.channels]);
  const domains = useMemo(() => selectDomains(management.categories), [management.categories]);
  const categories = useMemo(
    () => selectCategories(management.categories),
    [management.categories],
  );
  const anime = useMemo(() => selectAnime(management.entries), [management.entries]);
  const youtubeTracks = useMemo(
    () => selectYoutubeTracks(channels, feed.videos),
    [channels, feed.videos],
  );
  const notifications = useMemo(
    () => selectNotifications(feed, channels, anime),
    [anime, channels, feed],
  );
  const bellNotifications = useMemo(() => selectBellNotifications(messages), [messages]);
  const authError = authStatus === "error" && firstError ? asMessage(firstError) : null;
  const syncError = authStatus === "ready" && firstError ? asMessage(firstError) : null;
  const username = null;

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
