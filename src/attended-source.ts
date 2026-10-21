// Read-only adapter for already ingested, signed Ring events and validated decisions.
// It does not create a camera session, alter primary-household state, or invent timestamps.
import type { DatabaseSync } from 'node:sqlite';
import { parseMotionEvent } from './frames.ts';
import { personEvidence, validatePerception } from './perception.ts';
import type { TestEvidence, TestScope } from './attended-test.ts';

export function readAttendedEvidence(db: DatabaseSync, after: number, scope: TestScope) {
  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.perception, d.reason, e.payload, e.received_at,
    e.source, v.source AS evidence_source, v.capture_ts, v.evidence_id, d.zone
    FROM decisions d JOIN events e USING(source_event_id)
    LEFT JOIN evidence v USING(evidence_id) WHERE d.id > ? ORDER BY d.id LIMIT 100`,
    )
    .all(after) as unknown as {
    id: number;
    kind: string;
    perception: string | null;
    reason: string;
    payload: string;
    received_at: number;
    source: string;
    evidence_source: string | null;
    capture_ts: number | null;
    evidence_id: string | null;
    zone: string;
  }[];
  const frames: TestEvidence[] = [];
  for (const r of rows) {
    const ev = parseMotionEvent(JSON.parse(r.payload), r.received_at);
    if (
      !ev ||
      r.source !== 'ring' ||
      ![`ring:${scope.deviceId}`, 'live'].includes(r.evidence_source ?? '') ||
      ev.accountId !== scope.accountId ||
      ev.deviceId !== scope.deviceId ||
      r.zone !== scope.zone ||
      !r.evidence_id ||
      r.capture_ts === null
    )
      continue;
    const validated = validatePerception(JSON.parse(r.perception ?? 'null'), r.evidence_id);
    let verdict: TestEvidence['verdict'] = 'uncertain';
    if (validated.ok) {
      const person = personEvidence(validated.value);
      if (!person.signal && !person.contradiction) verdict = 'empty';
      // Preserve the normal household-context decision, including known/expected-person suppression.
      if (r.kind === 'intruder' && person.detected && !person.contradiction) verdict = 'person';
    }
    frames.push({ ...scope, id: r.evidence_id, captureTs: r.capture_ts, source: 'ring', verdict });
  }
  return { after: rows.at(-1)?.id ?? after, frames };
}
