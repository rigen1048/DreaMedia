/**
 * DreaMedia Extension — YouTube SQL User Layer
 * Operations intended to be used only when the User triggers them.
 * No `any` type permitted.
 */

import type { DomainRow } from "../../Config/Model/types";
import type { CardRow } from "../../Config/Model/types";

/**
 * User-triggered: mark a domain as enabled or disabled.
 */
export async function toggleDomainEnabled(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  domainId: number,
  enabled: boolean
): Promise<DomainRow> {
  const mutation = enabled
    ? `mutation EnableDomain($id: Int!) { enableDomain(id: $id) { id domain media enabled } }`
    : `mutation DisableDomain($id: Int!) { disableDomain(id: $id) { id domain media enabled } }`;
  const data = await sendGraphQL(mutation, { id: domainId });
  const key = enabled ? "enableDomain" : "disableDomain";
  const result = data as { [key: string]: DomainRow };
  const value = result[key];
  if (!value) {
    throw new Error(`Domain toggle returned no result for id ${domainId}`);
  }
  return value;
}

/**
 * User-triggered: add items to a card/playlist.
 */
export async function addCardItems(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  cardId: number,
  links: string[]
): Promise<{ added: number; requested: number; errors: string[] }> {
  const data = await sendGraphQL(
    `mutation AddItems($cardId: Int!, $links: [String!]!) {
      addCardItems(cardId: $cardId, links: $links) { added requested errors }
    }`,
    { cardId, links }
  );
  const result = data as { addCardItems: { added: number; requested: number; errors: string[] } };
  return result.addCardItems;
}

/**
 * User-triggered: fetch all cards.
 */
export async function userFetchCards(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>
): Promise<CardRow[]> {
  const data = await sendGraphQL(`query { cards { id name done total } }`, {});
  const result = data as { cards: CardRow[] };
  return result.cards ?? [];
}
