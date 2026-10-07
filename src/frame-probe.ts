// Frame-readiness probe (recon.md "Open: at_timestamp within ~2 s of a webhook").
// On each motion webhook, ask Ring for the frame at the event time at fixed offsets after
// receipt, stop at the first 200, and log status and timing only. No image is kept and nothing
// here can reach an actuator.
import type { ImageAttempt } from './ring.ts';

export const PROBE_OFFSETS_MS = [0, 2000, 5000];

export interface MotionEvent {
  accountId: string;
  deviceId: string;
  subType: string;
  eventTs: number;
  receivedAt: number;
}

export interface ProbeAttempt extends Partial<ImageAttempt> {
  offset_ms: number; // planned offset after receipt
  sent_after_event_ms: number;
  latency_ms: number;
  frame_minus_event_ms?: number;
  detail?: string;
}

export interface ProbeRecord {
  device_id: string;
  sub_type: string;
  event_ts: number;
  received_after_event_ms: number;
  skipped?: 'in_flight';
  ready_after_event_ms?: number;
  attempts: ProbeAttempt[];
}

export interface ProbeDeps {
  download: (accountId: string, deviceId: string, timestampMs: number) => Promise<ImageAttempt>;
  write: (record: ProbeRecord) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  offsetsMs?: number[];
}

export function parseMotionEvent(body: unknown, receivedAt: number): MotionEvent | undefined {
  const b = body as {
    meta?: { account_id?: unknown };
    data?: {
      type?: unknown;
      attributes?: { source?: unknown; sub_type?: unknown; timestamp?: unknown };
    };
  };
  const a = b?.data?.attributes;
  if (b?.data?.type !== 'motion_detected' || !a) return undefined;
  if (typeof b.meta?.account_id !== 'string' || typeof a.source !== 'string') return undefined;
  if (typeof a.timestamp !== 'number' || !Number.isFinite(a.timestamp)) return undefined;
  return {
    accountId: b.meta.account_id,
    deviceId: a.source,
    subType: typeof a.sub_type === 'string' ? a.sub_type : 'unknown',
    eventTs: a.timestamp,
    receivedAt,
  };
}

export function createFrameProbe(deps: ProbeDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const offsets = deps.offsetsMs ?? PROBE_OFFSETS_MS;
  const inFlight = new Set<string>();

  async function run(ev: MotionEvent): Promise<void> {
    const record: ProbeRecord = {
      device_id: ev.deviceId,
      sub_type: ev.subType,
      event_ts: ev.eventTs,
      received_after_event_ms: ev.receivedAt - ev.eventTs,
      attempts: [],
    };
    // One probe per camera at a time, so a burst of events cannot multiply Ring calls.
    if (inFlight.has(ev.deviceId)) {
      deps.write({ ...record, skipped: 'in_flight' });
      return;
    }
    inFlight.add(ev.deviceId);
    try {
      for (const offset of offsets) {
        const wait = ev.receivedAt + offset - now();
        if (wait > 0) await sleep(wait);
        const t0 = now();
        let attempt: Partial<ImageAttempt> & { detail?: string };
        try {
          attempt = await deps.download(ev.accountId, ev.deviceId, ev.eventTs);
        } catch (e) {
          attempt = { status: 0, error_code: 'FETCH_ERROR', detail: (e as Error).message };
        }
        const t1 = now();
        record.attempts.push({
          offset_ms: offset,
          sent_after_event_ms: t0 - ev.eventTs,
          latency_ms: t1 - t0,
          ...attempt,
          ...(attempt.media_timestamp
            ? { frame_minus_event_ms: attempt.media_timestamp - ev.eventTs }
            : {}),
        });
        if (attempt.status === 200) {
          record.ready_after_event_ms = t1 - ev.eventTs;
          break;
        }
      }
    } finally {
      inFlight.delete(ev.deviceId);
      deps.write(record);
    }
  }

  return { run };
}
