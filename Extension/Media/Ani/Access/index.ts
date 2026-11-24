/**
 * DreaMedia Extension — Anime Access Layer
 * User's Write and Delete Operations for anime domains.
 * No `any` type permitted.
 */

import type { SubscriptionOptions } from "../Config/Model/types";
import type { DomainRow } from "../Config/Model/types";

export async function subscribe(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  options: SubscriptionOptions
): Promise<{ ok: boolean; channelId: number | null }> {
  const data = await sendGraphQL(
    `mutation Subscribe($link: String!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
      subscribe(link: $link, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { ok channelId }
    }`,
    {
      link: options.link ?? "",
      kind: options.kind,
      words: options.words ?? null,
      rank: options.rank ?? null,
      withhold: options.withhold ?? null,
      domain: options.domain ?? null,
      subdomain: options.subdomain ?? null,
    }
  );
  const result = data as { subscribe: { ok: boolean; channelId: number } };
  return { ok: result.subscribe.ok, channelId: result.subscribe.channelId };
}

export async function addDomain(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  domain: string,
  media: "yt" | "ani"
): Promise<DomainRow> {
  const data = await sendGraphQL(
    `mutation AddDomain($domain: String!, $media: String!) {
      addDomain(domain: $domain, media: $media) { id domain media enabled }
    }`,
    { domain, media }
  );
  const result = data as { addDomain: DomainRow };
  return result.addDomain;
}

export async function removeDomain(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  domainId: number
): Promise<void> {
  const data = await sendGraphQL(
    `mutation RemoveDomain($id: Int!) { removeDomain(id: $id) { ok } }`,
    { id: domainId }
  );
  const result = data as { removeDomain: { ok: boolean } };
  if (!result.removeDomain.ok) {
    throw new Error(`Failed to remove domain ${domainId}`);
  }
}
