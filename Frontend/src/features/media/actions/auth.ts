import { useCallback } from "react";
import { api } from "../api";
import type { AfterAction } from "./shared";

type AuthActionOptions = {
  after: AfterAction;
  reset: () => void;
};

export function useAuthActions({ after, reset }: AuthActionOptions) {
  const login = useCallback(
    async (name: string, password: string): Promise<void> => {
      await after(() => api.auth.login(name, password));
    },
    [after],
  );
  const signup = useCallback(
    async (name: string, password: string): Promise<void> => {
      await after(() => api.auth.signup(name, password));
    },
    [after],
  );
  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.auth.logout();
    } finally {
      reset();
    }
  }, [reset]);

  return { login, signup, logout };
}
