import type {
  AniEntry,
  ApiDomain,
  AniEvent,
  BackendNotification,
  YtChannel,
  YtVideo,
} from "../api";
import type { FeedBundle } from "../api/graphqlFeed";
import type {
  AnimeTrack,
  BellNotification,
  Category,
  ManagedChannel,
  ManagedDomain,
  MediaNotification,
  YoutubeTrack,
} from "../model/types";
import { channelMode, colors, normalizeAnime, normalizeBell, pretty, relTime } from "./normalizers";

export function selectChannels(channels: YtChannel[]): ManagedChannel[] {
  return channels.map((channel) => ({
    id: channel.id,
    name: channel.name ?? "Untitled channel",
    url: channel.url ?? "",
    mode: channelMode(channel.kind),
    kind: channel.kind,
    active: channel.label === "reserved" ? false : channel.active,
    rank: channel.rank,
    words: channel.words,
    logo: channel.logo ?? "",
    rssId: channel.rss_id,
    domain: channel.domain,
    subdomain: channel.subdomain,
    label: channel.label,
    note: channel.label_reason ?? "",
  }));
}

export function selectDomains(categories: ApiDomain[]): ManagedDomain[] {
  return categories.map((domain) => ({
    id: domain.id,
    name: domain.name,
    active: domain.active,
    subdomains: domain.subdomains,
  }));
}

export function selectCategories(categories: ApiDomain[]): Category[] {
  return categories.flatMap((domain) =>
    domain.subdomains.map((subdomain) => ({
      id: `${domain.id}:${subdomain.id}`,
      domain: domain.name,
      subdomain: subdomain.name,
      active: domain.active && subdomain.active,
      domainId: domain.id,
      subdomainId: subdomain.id,
    })),
  );
}

export function selectAnime(entries: AniEntry[]): AnimeTrack[] {
  return entries.map(normalizeAnime);
}

export function selectYoutubeTracks(channels: ManagedChannel[], videos: YtVideo[]): YoutubeTrack[] {
  return channels
    .filter((channel) => channel.label === "none" && channel.active !== false)
    .map((channel) => ({
      id: String(channel.id),
      channelId: channel.id,
      title: channel.name,
      url: channel.url,
      logo: channel.logo ?? "",
      rssId: channel.rssId,
      domain: channel.domain,
      subdomain: channel.subdomain,
      videos: videos
        .filter((video) => video.channel_id === channel.id)
        .map((video, index) => ({
          id: video.id,
          title: video.title ?? "Untitled video",
          channel: video.channel ?? channel.name,
          url: video.url ?? "",
          thumbnail: video.thumbnail ?? "",
          age: relTime(video.published_at),
          seen: video.seen,
          color: colors[index % colors.length],
        })),
    }));
}

function selectYoutubeNotifications(
  videos: YtVideo[],
  channels: ManagedChannel[],
): MediaNotification[] {
  const byChannel = new Map(channels.map((channel) => [channel.id, channel]));
  return videos.map((video, index) => {
    const channel = byChannel.get(video.channel_id);
    const timestamp = video.published_at ?? 0;
    return {
      id: `youtube:${video.id}`,
      backendId: video.id,
      source: "youtube",
      mode: channel?.mode ?? "Unknown",
      creator: video.channel ?? channel?.name ?? "YouTube",
      channelLogo: video.channel_logo ?? channel?.logo ?? "",
      thumbnail: video.thumbnail ?? "",
      title: video.title ?? "Untitled video",
      summary: video.url ?? "",
      domain: channel?.domain ?? "Unsorted",
      subdomain: channel?.subdomain ?? "Unsorted",
      time: relTime(timestamp),
      unread: !video.seen,
      color: colors[index % colors.length],
      timestamp,
    };
  });
}

function selectAniNotifications(events: AniEvent[], anime: AnimeTrack[]): MediaNotification[] {
  const byEntry = new Map(anime.map((entry) => [entry.backendId, entry]));
  return events.map((event, index) => {
    const timestamp = new Date(event.created_at).getTime();
    const title =
      typeof event.payload.title === "string" ? event.payload.title : pretty(event.kind);
    return {
      id: `ani:${event.id}`,
      backendId: event.id,
      source: "ani",
      mode: "Unknown",
      creator: byEntry.get(event.entry_id)?.title ?? "Ani update",
      channelLogo: "",
      thumbnail: "",
      title,
      summary: `${pretty(event.kind)} · ${pretty(event.tier)}`,
      domain: "Anime",
      subdomain: event.season_no ? `Season ${event.season_no}` : "Anime",
      time: relTime(event.created_at),
      unread: !event.seen,
      color: colors[index % colors.length],
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
    };
  });
}

export function selectNotifications(
  bundle: FeedBundle,
  channels: ManagedChannel[],
  anime: AnimeTrack[],
): MediaNotification[] {
  return [
    ...selectYoutubeNotifications(bundle.videos, channels),
    ...selectAniNotifications(bundle.events, anime),
  ].sort((left, right) => right.timestamp - left.timestamp);
}

export function selectBellNotifications(notifications: BackendNotification[]): BellNotification[] {
  return notifications
    .map(normalizeBell)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 30);
}
