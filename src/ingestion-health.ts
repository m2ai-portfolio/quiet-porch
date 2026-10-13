import type { DatabaseSync } from 'node:sqlite';
export interface IngestionHealth {
  status: 'recent' | 'gap' | 'unknown';
  detail: string;
  lastReceivedAt: number | null;
}
// No webhook heartbeat is promised by Ring. Recency is observable; full coverage is not.
export function ingestionHealth(
  db: DatabaseSync,
  now: number,
  accountId?: string,
): IngestionHealth {
  const row = db
    .prepare(
      `SELECT MAX(received_at) AS ts FROM events WHERE source='ring'
    AND (? IS NULL OR json_extract(payload, '$.meta.account_id')=?)`,
    )
    .get(accountId ?? null, accountId ?? null) as { ts: number | null };
  if (row.ts === null)
    return {
      status: 'unknown',
      lastReceivedAt: null,
      detail: 'No received events; delivery coverage unverified',
    };
  const gap = now - row.ts;
  return {
    status: gap > 60 * 60_000 ? 'gap' : 'recent',
    lastReceivedAt: row.ts,
    detail:
      gap > 60 * 60_000
        ? 'No events received for over an hour; motion absence and delivery failure cannot be distinguished'
        : 'Recent events received; full-night delivery coverage remains unverified',
  };
}
