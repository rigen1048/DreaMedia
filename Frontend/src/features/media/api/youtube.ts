import { post, request } from "../../../shared/api/http";

export type YtKind = "tracking" | "wordscan" | "playlist" | "random";

export type YtVideo = {
  id: number;
  channel_id: number;
  title: string | null;
  url: string | null;
  thumbnail: string | null;
  channel_logo?: string | null;
  published_at: number | null;
  seen: boolean;
  channel: string | null;
};

export type YtChannel = {
  id: number;
  name: string | null;
  url: string | null;
  logo: string | null;
  label: "none" | "reserved" | "blocked";
  label_reason: string | null;
  rss_id: string | null;
  kind: YtKind | null;
  active: boolean | null;
  rank: string | null;
  words: string[];
  domain: string;
  subdomain: string;
};

export type SidebarDomain = {
  key: string;
  name: string;
  active: boolean;
  subdomains: {
    key: string;
    name: string;
    active: boolean;
  }[];
};

export type ApiDomain = {
  id: number;
  name: string;
  active: boolean;
  subdomains: {
    id: number;
    name: string;
    active: boolean;
  }[];
};

export type SubscribeInput = {
  kind: YtKind;
  link: string;
  words?: string[];
  rank?: string;
};

export const youtubeApi = {
  categories: () => request<{ domains: ApiDomain[] }>("/yt/access/categories"),
  subscribe: (input: SubscribeInput) =>
    request<{ ok: true; channel_id: number }>("/yt/access/subscribe", post(input)),
  switchMode: (id: number, kind: YtKind, words?: string[], rank?: string) =>
    request<{ ok: true; id: number; kind: YtKind }>(
      `/yt/access/channels/${id}/mode`,
      post({ kind, words, rank }),
    ),
  setChannelActive: (id: number, active: boolean) =>
    request<{ ok: true; id: number; active: boolean }>(
      `/yt/access/channels/${id}/active`,
      post({ active }),
    ),
  refreshRandom: (channelId: number) =>
    request<{ ok: boolean; refreshed?: number; error?: string }>(
      `/yt/access/random/${channelId}/refresh`,
      { method: "POST" },
    ),
  setChannelLabel: (id: number, label: YtChannel["label"], reason?: string) =>
    request<{ ok: true }>(`/yt/access/channels/${id}/label`, post({ label, reason })),
  assignChannel: (id: number, domain: string, subdomain: string | null) =>
    request<{ ok: true }>(`/yt/access/channels/${id}/assign`, post({ domain, subdomain })),
  deleteChannel: (id: number) =>
    request<{ ok: true }>(`/yt/access/channels/${id}/delete`, post({})),
  setCategoryActive: (domain: string, subdomain: string | null, active: boolean) =>
    request<{ ok: true }>("/yt/access/category/active", post({ domain, subdomain, active })),
  createCategory: (domain: string, subdomain: string | null) =>
    request<{ ok: true }>("/yt/access/categories", post({ domain, subdomain })),
  renameCategory: (domain: string, new_name: string, subdomain: string | null) =>
    request<{ ok: true }>("/yt/access/categories/rename", post({ domain, new_name, subdomain })),
  deleteCategory: (domain: string, subdomain: string | null) =>
    request<{ ok: true }>("/yt/access/categories/delete", post({ domain, subdomain })),
};
