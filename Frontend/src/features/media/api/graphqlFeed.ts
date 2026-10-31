import { BackendError } from "../../../shared/api/http";
import { graphQLRequest } from "../../../shared/api/graphql";
import type { AniEvent } from "./ani";
import type { SidebarDomain, YtChannel, YtVideo } from "./youtube";

export type FeedBundle = {
  videos: YtVideo[];
  sidebar: SidebarDomain[];
  channels: YtChannel[];
  events: AniEvent[];
};

type GraphqlYtVideo = {
  id: number;
  channelId: number;
  title: string | null;
  url: string | null;
  thumbnail: string | null;
  publishedAt: number | null;
  seen: boolean;
  channel: string | null;
};

type GraphqlYtChannel = {
  id: number;
  name: string | null;
  url: string | null;
  label: YtChannel["label"];
  labelReason: string | null;
  rssId: string | null;
  kind: YtChannel["kind"];
  active: boolean | null;
  rank: string | null;
  words: string[];
  domain: string;
  subdomain: string;
};

type GraphqlAniEvent = {
  id: number;
  entryId: number;
  seasonNo: number | null;
  kind: string;
  tier: AniEvent["tier"];
  seen: boolean;
  createdAt: string;
  payload: string;
};

type GraphqlFeedResponse = {
  ytFeed: GraphqlYtVideo[];
  ytSidebar: Array<{
    key: string;
    name: string;
    active: boolean;
    subdomains: Array<{ key: string; name: string; active: boolean }>;
  }>;
  ytChannels: GraphqlYtChannel[];
  aniEvents: GraphqlAniEvent[];
};

const feedQuery = `
  query DreaMediaFeed($limit: Int!, $includeSeen: Boolean!, $includeBlocked: Boolean!) {
    ytFeed(limit: $limit) {
      id
      channelId
      title
      url
      thumbnail
      publishedAt
      seen
      channel
    }
    ytSidebar { key name active subdomains { key name active } }
    ytChannels(includeBlocked: $includeBlocked) {
      id
      name
      url
      label
      labelReason
      rssId
      kind
      active
      rank
      words
      domain
      subdomain
    }
    aniEvents(includeSeen: $includeSeen) {
      id
      entryId
      seasonNo
      kind
      tier
      seen
      createdAt
      payload
    }
  }
`;

const markYoutubeSeenMutation = `
  mutation MarkYoutubeVideosSeen($videoIds: [Int!]!, $seen: Boolean!) {
    ytMarkSeen(videoIds: $videoIds, seen: $seen)
  }
`;

const markAniEventsSeenMutation = `
  mutation MarkAniEventsSeen($eventIds: [Int!]!, $seen: Boolean!) {
    aniEventsSeen(eventIds: $eventIds, seen: $seen)
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSidebar(domains: GraphqlFeedResponse["ytSidebar"]): SidebarDomain[] {
  return domains.map((domain) => ({
    key: domain.key,
    name: domain.name,
    active: domain.active,
    subdomains: domain.subdomains.map((sub) => ({ key: sub.key, name: sub.name, active: sub.active })),
  }));
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(json);
    return isRecord(decoded) ? decoded : {};
  } catch {
    return {};
  }
}

export const graphqlFeedApi = {
  read: async (limit = 500): Promise<FeedBundle> => {
    const response = await graphQLRequest<GraphqlFeedResponse>(feedQuery, {
      limit,
      includeSeen: true,
      includeBlocked: true,
    });

    return {
      videos: response.ytFeed.map((video) => ({
        id: video.id,
        channel_id: video.channelId,
        title: video.title,
        url: video.url,
        thumbnail: video.thumbnail,
        published_at: video.publishedAt,
        seen: video.seen,
        channel: video.channel,
      })),
      sidebar: parseSidebar(response.ytSidebar),
      channels: response.ytChannels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        url: channel.url,
        label: channel.label,
        label_reason: channel.labelReason,
        rss_id: channel.rssId,
        kind: channel.kind,
        active: channel.active,
        rank: channel.rank,
        words: channel.words,
        domain: channel.domain,
        subdomain: channel.subdomain,
      })),
      events: response.aniEvents.map((event) => ({
        id: event.id,
        entry_id: event.entryId,
        season_no: event.seasonNo,
        kind: event.kind,
        tier: event.tier,
        seen: event.seen,
        created_at: event.createdAt,
        payload: parsePayload(event.payload),
      })),
    };
  },
  markYoutubeSeen: async (videoIds: number[], seen = true): Promise<number> => {
    if (!videoIds.length) return 0;
    const response = await graphQLRequest<{ ytMarkSeen: number }>(markYoutubeSeenMutation, {
      videoIds,
      seen,
    });
    return response.ytMarkSeen;
  },
  markAniEventsSeen: async (eventIds: number[], seen = true): Promise<number> => {
    if (!eventIds.length) return 0;
    const response = await graphQLRequest<{ aniEventsSeen: number }>(markAniEventsSeenMutation, {
      eventIds,
      seen,
    });
    return response.aniEventsSeen;
  },
};
