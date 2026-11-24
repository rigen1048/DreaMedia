/**
 * DreaMedia Extension — YouTube Filter Layer
 * Filtering logic for YouTube channels and items. No `any` type permitted.
 */

import type { Channel } from "../Config/Model/types";

/**
 * Filter channels by whether they match a search term.
 */
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

/**
 * Filter channels by whether they are already imported (present in existing keys).
 */
export function filterNewChannels(
  channels: Channel[],
  existingKeys: Set<string>
): Channel[] {
  return channels.filter((channel) => {
    const key = channel.url.toLowerCase();
    return !existingKeys.has(key);
  });
}
