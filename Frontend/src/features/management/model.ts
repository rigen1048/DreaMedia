import type { ManagedChannel } from "../media";
import type { SubscribeInput, YtKind } from "../media/api";

export type ManagementTab = "channels" | "categories" | "inactive";

export const frequencies = [
  ["day", "Daily"],
  ["tri_day", "Every 3 days"],
  ["week", "Weekly"],
  ["bi_week", "Every 2 weeks"],
  ["tri_week", "Every 3 weeks"],
  ["month", "Monthly"],
  ["bi_month", "Every 2 months"],
  ["quarter", "Quarterly"],
  ["half_year", "Every 6 months"],
  ["year", "Yearly"],
] as const;

export const modeLabel: Record<YtKind, string> = {
  tracking: "Track",
  wordscan: "Wordscan",
  playlist: "Playlist",
  random: "Random",
};

export type CategoryAssignment = {
  domain: string;
  subdomain: string;
};

export function createSubscribeInput(
  kind: YtKind,
  link: string,
  words: string,
  rank: string,
): SubscribeInput {
  const cleanedLink = link.trim();
  if (!cleanedLink) {
    throw new Error("Paste a YouTube channel or playlist link.");
  }

  const parsedWords = words
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
  if (kind === "wordscan" && parsedWords.length === 0) {
    throw new Error("Enter at least one Wordscan term.");
  }

  return {
    kind,
    link: cleanedLink,
    words: kind === "wordscan" ? parsedWords : undefined,
    rank: kind === "random" ? rank : undefined,
  };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export type ChannelLabel = ManagedChannel["label"];
