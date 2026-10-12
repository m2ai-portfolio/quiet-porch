// Turns a recorded night in the live database into a replay fixture (F9). Read-only: it takes
// an open database, a window of Ring event times and the config, and returns a Fixture plus the
// list of frame files to copy. The model answers it stores are the ones Bedrock actually gave
// (decisions.perception / decisions.critique), so a replay judges the same way the night did.
import type { DatabaseSync } from 'node:sqlite';
import type { Mode } from './ladder.ts';
import type { LedgerLine } from './ledger.ts';
import type { Fixture, FixtureEvent } from './replay.ts';

export interface ExportOptions {
  from: number; // Ring event time window, inclusive
  to: number;
  label: string; // e.g. "replay of 2026-10-12"
  mode: Mode;
  config: Record<string, unknown>; // config/quiet-porch.json, coordinator section included
  allowlist: unknown;
  hasFrame?: (evidenceId: string) => boolean; // is frames/<evidenceId>.jpg on disk
  readyAfterEventMs?: (deviceId: string, eventTs: number) => number | undefined; // frame-probe.jsonl
  modelMs?: (sourceEventId: string) => { perception?: number; critique?: number } | undefined; // decisions.jsonl
}

interface Row {
  id: string;
  received_at: number;
  payload: string;
  perception: string | null;
  critique: string | null;
  evidence_id: string | null;
  capture_ts: number | null;
}

function modelJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  const o = JSON.parse(raw) as Record<string, unknown>;
  delete o.evidence_id; // the replay fills in the evidence id of the replayed frame
  return o;
}

export function exportFixture(
  db: DatabaseSync,
  o: ExportOptions,
): { fixture: Fixture; frames: { evidenceId: string; file: string }[] } {
  const rows = db
    .prepare(
      `SELECT e.source_event_id AS id, e.received_at AS received_at, e.payload AS payload,
         COALESCE(CAST(json_extract(e.payload, '$.data.attributes.timestamp') AS INTEGER), e.received_at) AS ts,
         d.perception AS perception, d.critique AS critique, d.evidence_id AS evidence_id,
         ev.capture_ts AS capture_ts
       FROM events e
       LEFT JOIN decisions d ON d.source_event_id = e.source_event_id
       LEFT JOIN evidence ev ON ev.evidence_id = d.evidence_id
       WHERE e.type = 'motion_detected' AND ts BETWEEN ? AND ?
       ORDER BY ts, e.id`,
    )
    .all(o.from, o.to) as unknown as Row[];
  if (rows.length === 0) throw new Error('no motion events in that window');

  const frames: { evidenceId: string; file: string }[] = [];
  const events: FixtureEvent[] = rows.map((r) => {
    const webhook = JSON.parse(r.payload) as {
      data?: { attributes?: { source?: string; timestamp?: number } };
    };
    const attrs = webhook.data?.attributes;
    const frame =
      r.evidence_id && r.capture_ts !== null
        ? [
            {
              ts_ring: r.capture_ts,
              ...(o.hasFrame?.(r.evidence_id) ? { file: `frames/${r.evidence_id}.jpg` } : {}),
            },
          ]
        : [];
    if (r.evidence_id && o.hasFrame?.(r.evidence_id)) {
      frames.push({ evidenceId: r.evidence_id, file: `frames/${r.evidence_id}.jpg` });
    }
    const ms = o.modelMs?.(r.id);
    const ready = o.readyAfterEventMs?.(attrs?.source ?? '', attrs?.timestamp ?? 0);
    return {
      received_at: r.received_at,
      webhook,
      frames: frame,
      ...(ready !== undefined ? { ready_after_event_ms: ready } : {}),
      model: {
        perception: modelJson(r.perception),
        critique: modelJson(r.critique),
        ...(ms?.perception !== undefined ? { perception_ms: ms.perception } : {}),
        ...(ms?.critique !== undefined ? { critique_ms: ms.critique } : {}),
      },
    };
  });
  return {
    fixture: {
      version: 1,
      label: o.label,
      mode: o.mode,
      config: o.config,
      allowlist: o.allowlist,
      events,
    },
    frames,
  };
}

// What a replay must reproduce of the original night: when, what, how far and why it stopped.
// Evidence ages are NOT compared: the live pipeline overlaps events and a replay runs them in
// order, so ages differ by design. The caller prints these differences, never hides them.
export function compareLedgers(original: LedgerLine[], replayed: LedgerLine[]): string[] {
  const key = (l: LedgerLine) =>
    [l.ts_ring, l.kind, l.what, l.profile ?? '-', `L${l.level}`, l.stop_reason].join(' | ');
  const out: string[] = [];
  const n = Math.max(original.length, replayed.length);
  for (let i = 0; i < n; i++) {
    const a = original[i] ? key(original[i]) : '(no line)';
    const b = replayed[i] ? key(replayed[i]) : '(no line)';
    if (a !== b) out.push(`line ${i + 1}: original [${a}] replay [${b}]`);
  }
  return out;
}
