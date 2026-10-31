import { post, request } from "../../../shared/api/http";

export type BackendNotification = {
  id: number;
  media: string;
  kind: string;
  payload: Record<string, unknown>;
  pushed: boolean;
  seen: boolean;
  created_at: string;
};

export type NotificationListResponse = {
  notifications: BackendNotification[];
};

export const notificationHistoryApi = {
  list: () => request<NotificationListResponse>("/notifications"),
  markSeen: (ids: number[], seen = true) =>
    request<{ ok: true; changed: number }>("/notifications/seen", post({ ids, seen })),
};
