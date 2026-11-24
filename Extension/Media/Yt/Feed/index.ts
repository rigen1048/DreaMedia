/**
 * DreaMedia Extension — YouTube Feed Layer
 * User's Read Operations. Triggered by frontend/popup reads.
 * No `any` type permitted.
 */

import type { DomainRow } from "../Config/Model/types";
import type { CategoryRow } from "../Config/Model/types";
import type { CardRow } from "../Config/Model/types";

/**
 * Fetch all domains via GraphQL.
 */
export async function fetchDomains(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>
): Promise<DomainRow[]> {
  const data = await sendGraphQL(`query { domains { id domain media enabled } }`, {});
  const result = data as { domains: DomainRow[] };
  return result.domains ?? [];
}

/**
 * Fetch categories with subdomains via GraphQL.
 */
export async function fetchCategories(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>
): Promise<CategoryRow[]> {
  const data = await sendGraphQL(`query { ytCategories { id name subdomains { id name } } }`, {});
  const result = data as { ytCategories: CategoryRow[] };
  return result.ytCategories ?? [];
}

/**
 * Fetch cards/playlists via GraphQL.
 */
export async function fetchCards(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>
): Promise<CardRow[]> {
  const data = await sendGraphQL(`query { cards { id name done total } }`, {});
  const result = data as { cards: CardRow[] };
  return result.cards ?? [];
}

/**
 * Check domain status for a URL via GraphQL.
 */
export async function checkDomainStatus(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  url: string
): Promise<{ host: string; registered: DomainRow | null }> {
  const data = await sendGraphQL(
    `mutation DomainStatus($url: String!) {
      domainStatus(url: $url) { host domain media enabled }
    }`,
    { url }
  );
  const result = data as { domainStatus: { host: string; domain: string; media: string; enabled: boolean } | null };
  const host = new URL(url).hostname;
  return {
    host,
    registered: result.domainStatus
      ? { id: 0, domain: result.domainStatus.domain, media: result.domainStatus.media as "yt", enabled: result.domainStatus.enabled }
      : null,
  };
}
