/**
 * DreaMedia Extension — Anime Type Models
 * All domain models used across Media/Ani, PopUI, and shared layers.
 * No `any` type is permitted anywhere in this file.
 */

export type MediaKind = "yt" | "ani";

export type ImportStatus =
  | "queued"
  | "resolving"
  | "resolved"
  | "processing"
  | "running"
  | "added"
  | "skipped"
  | "failed"
  | "completed"
  | "partial";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";

export interface DomainRow {
  id: number;
  domain: string;
  media: MediaKind;
  enabled: boolean;
}

export interface Channel {
  url: string;
  name: string;
}

export interface ImportItem {
  ordinal: number;
  link: string;
  status: ImportStatus;
  error: string | null;
  retryable: boolean;
}

export interface ImportJob {
  jobId: string;
  status: ImportStatus;
  requested: number;
  processed: number;
  resolved: number;
  added: number;
  skipped: number;
  failed: number;
  errors: string[];
  items: ImportItem[] | null;
}

export interface ConnectionState {
  status: ConnectionStatus;
  reason: string;
}

export interface SubscriptionOptions {
  kind: string;
  words: string[] | null;
  rank: string | null;
  withhold: number | null;
  domain: string | null;
  subdomain: string | null;
  link?: string;
}

export interface AnimeUrlHint {
  season: number | null;
  episode: number | null;
  source: string;
  confidence: "none" | "medium" | "high";
}

export interface TrackingSnapshot {
  bound: boolean;
  entryId: number | null;
  title: string;
  season: number | null;
  episode: number | null;
  episodeSource: string;
  positionSeconds: number | null;
  durationSeconds: number | null;
  playing: boolean;
  state: string;
  pageTitle: string;
  urlEpisode: number | null;
  urlSeason: number | null;
  urlEpisodeSource: string;
  url: string;
  sampledAt: number;
}

export interface CardRow {
  id: number;
  name: string;
  done: number;
  total: number;
}

export interface CategoryRow {
  id: number;
  name: string;
  subdomains: { id: number; name: string }[];
}

export interface BackgroundMessage {
  type: string;
  [key: string]: unknown;
}

export interface BackgroundMessageResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}
