import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { BackendError, isAuthError } from "../lib/gql";
import type { Workspace } from "../lib/types";
import * as api from "./api";

type Toast = { id: number; message: string; tone: "error" | "ok" | "info" };

type AppState = {
  viewer: Workspace["viewer"];
  workspace: Workspace | null;
  loading: boolean;
  refreshing: boolean;
  authError: string | null;
  refresh: () => Promise<unknown>;
  login: (username: string, password: string) => Promise<void>;
  signup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  act: (operation: () => Promise<unknown>, success?: string) => Promise<boolean>;
  notify: (message: string, tone?: Toast["tone"]) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
};

const Context = createContext<AppState | null>(null);

const EMPTY: Workspace = {
  viewer: null,
  ytFeed: [],
  ytChannels: [],
  ytDomains: [],
  ytUnassignedCount: 0,
  ytCards: [],
  aniEntries: [],
  aniEvents: [],
  aniDomains: [],
};

export function AppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const toastId = useRef(0);

  const pushToast = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const query = useQuery({
    queryKey: ["workspace"],
    queryFn: api.fetchWorkspace,
    refetchInterval: 45_000,
    retry: false,
  });

  const refresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      return await query.refetch();
    } finally {
      setManualRefreshing(false);
    }
  }, [query]);

  const act = useCallback(
    async (operation: () => Promise<unknown>, success?: string) => {
      try {
        await operation();
        // Invalidate alone can leave controlled switches/selects showing the
        // pre-mutation snapshot until a later poll. Refetch the active query
        // before returning so every caller renders the server's new state.
        await queryClient.refetchQueries({ queryKey: ["workspace"], type: "active" });
        if (success) pushToast(success, "ok");
        return true;
      } catch (error) {
        const message =
          error instanceof BackendError || error instanceof Error
            ? error.message
            : "The backend rejected this change.";
        pushToast(message, "error");
        return false;
      }
    },
    [pushToast, queryClient],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      await api.login(username, password);
      await queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const signup = useCallback(
    async (username: string, password: string) => {
      await api.signup(username, password);
      await queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      queryClient.clear();
      // P8: kick out immediately — send the user straight to the login screen
      // instead of leaving them in a loading state after the cache clears.
      navigate("/");
    }
  }, [queryClient, navigate]);

  const value = useMemo<AppState>(() => {
    const workspace = query.data ?? null;
    const unauthorized = isAuthError(query.error) || (workspace && !workspace.viewer);
    return {
      viewer: workspace?.viewer ?? null,
      workspace,
      loading: query.isPending && !query.data,
      refreshing: manualRefreshing || query.isFetching,
      authError: unauthorized ? null : query.error instanceof Error ? query.error.message : null,
      refresh,
      login,
      signup,
      logout,
      act,
      notify: pushToast,
      toasts,
      dismissToast,
    };
  }, [
    act,
    dismissToast,
    login,
    manualRefreshing,
    logout,
    query.data,
    query.error,
    query.isFetching,
    query.isPending,
    pushToast,
    refresh,
    signup,
    toasts,
  ]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useApp(): AppState {
  const value = useContext(Context);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function useWorkspace(): Workspace {
  const { workspace } = useApp();
  return workspace ?? EMPTY;
}
