/**
 * DreaMedia Extension — Anime Filter Layer
 * Filtering logic for anime channels and items. No `any` type permitted.
 */

import type { Channel } from "../Config/Model/types";

export function filterChannelsByName(
  channels: Channel[],
  searchTerm: string
): Channel[] {
  const term = searchTerm.toLowerCase().trim();
  if (!term) return channels;
  return channels.filter((channel) =>
    channel.name.toLowerCase().includes(term) ||
    channel.url.toLowerCase().includes(term)
  );
}

export function filterNewChannels(
  channels: Channel[],
  existingKeys: Set<string>
): Channel[] {
  return channels.filter((channel) => {
    const key = channel.url.toLowerCase();
    return !existingKeys.has(key);
  });
}
