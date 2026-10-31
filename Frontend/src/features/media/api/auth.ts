import { post, request } from "../../../shared/api/http";

export type AuthResult = {
  ok: true;
  user_id: number;
  username: string;
  role: string;
};

export const authApi = {
  login: (username: string, password: string) =>
    request<AuthResult>("/auth/login", post({ username, password })),
  signup: (username: string, password: string) =>
    request<AuthResult>("/auth/signup", post({ username, password })),
  logout: () => request<{ ok: true }>("/auth/logout", post({})),
};
