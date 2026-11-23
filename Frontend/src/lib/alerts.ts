import { gql } from "./gql";
import type { Alert } from "./types";

/**
 * The bell's alert lane (D60/D61): backend-driven, unhappy-path only.
 * GraphQL only — the frontend has no REST surface.
 */

const ALERT_FIELDS = "id media kind title message level url createdAt seen payload";

export async function listAlerts(): Promise<Alert[]> {
  const data = await gql<{ alerts: Alert[] }>(
    `{ alerts(limit: 100) { ${ALERT_FIELDS} } }`,
  );
  return data.alerts ?? [];
}

export async function markAlertsSeen(ids: number[], seen = true): Promise<void> {
  if (!ids.length) return;
  await gql<{ markAlertsSeen: number }>(
    "mutation($ids:[Int!]!,$seen:Boolean!){ markAlertsSeen(ids:$ids, seen:$seen) }",
    { ids, seen },
  );
}
