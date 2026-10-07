// Frame acquisition (plan v7 section 2). The Ring adapter owns capture time; the model never
// does. One implementation serves the decision pipeline and the readiness probe:
//   - acquireEventFrame: at_timestamp at the event time, retried at receipt +0/+2/+5 s on a
//     non-200, accepted only if it is the event's own recorded frame (checkEventFrame);
//   - probeFollowUps: step 1 recon for dwell frames (source A), at_timestamp at now - 2 s while
//     the camera may still be recording. Logged only, never used for a decision yet.
// Each event writes one ProbeRecord (status and timing only, never image bytes).
import type { ImageAttempt } from './ring.ts';

// Event-frame attempts. Live readiness ranged 1.9 s to more than 5 s (10-07 21:05Z event:
// 416 at +0, +2, +5 s; recording at +10 s), so retries run out to +12 s.
export const PROBE_OFFSETS_MS = [0, 2000, 5000, 8000, 12000];
export const FOLLOW_UP_OFFSETS_MS = [5000, 10000, 15000];
export const FOLLOW_UP_LOOKBACK_MS = 2000;
export const EVENT_FRAME_TOLERANCE_MS = 1000;

export interface MotionEvent {
  accountId: string;
  deviceId: string;
  eventId: string;
  subType: string;
  eventTs: number;
  receivedAt: number;
}

export type Download = (
  accountId: string,
  deviceId: string,
  timestampMs: number,
  opts?: { keepImage?: boolean },
) => Promise<ImageAttempt>;

export interface ProbeAttempt extends Omit<Partial<ImageAttempt>, 'image'> {
  offset_ms: number; // planned offset after receipt
  sent_after_event_ms: number;
  latency_ms: number;
  frame_minus_event_ms?: number;
  rejected?: string; // why a 200 was not accepted as the event frame
  detail?: string;
}

export interface FollowUpAttempt extends Omit<Partial<ImageAttempt>, 'image'> {
  offset_ms: number;
  requested_ts: number;
  frame_minus_requested_ms?: number;
  detail?: string;
}

export interface ProbeRecord {
  device_id: string;
  sub_type: string;
  event_ts: number;
  received_after_event_ms: number;
  ready_after_event_ms?: number;
  attempts: ProbeAttempt[];
  follow_ups?: FollowUpAttempt[];
}

export interface EventFrame {
  jpeg: Buffer;
  captureTs: number;
  origin: string;
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realClock: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
};

export type FrameCheck = { ok: true } | { ok: false; reason: string };

// The event's own frame: a recorded JPEG whose capture time is within the tolerance of the
// event and not after we received the webhook. A fresh snapshot is rejected however new.
export function checkEventFrame(a: ImageAttempt, eventTs: number, receivedAt: number): FrameCheck {
  if (a.status !== 200) return { ok: false, reason: `http_${a.status}` };
  if (!a.content_type?.startsWith('image/jpeg')) return { ok: false, reason: 'not_jpeg' };
  if (a.media_origin !== 'recording') {
    return { ok: false, reason: `origin_${a.media_origin ?? 'missing'}` };
  }
  const ts = a.media_timestamp;
  if (ts === undefined || !Number.isFinite(ts)) return { ok: false, reason: 'no_media_timestamp' };
  if (ts > receivedAt) return { ok: false, reason: 'capture_after_receipt' };
  if (Math.abs(ts - eventTs) > EVENT_FRAME_TOLERANCE_MS) {
    return { ok: false, reason: 'capture_outside_tolerance' };
  }
  return { ok: true };
}

export function parseMotionEvent(body: unknown, receivedAt: number): MotionEvent | undefined {
  const b = body as {
    meta?: { account_id?: unknown };
    data?: {
      id?: unknown;
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
    eventId: typeof b.data.id === 'string' ? b.data.id : `${a.source}_${a.timestamp}`,
    subType: typeof a.sub_type === 'string' ? a.sub_type : 'unknown',
    eventTs: a.timestamp,
    receivedAt,
  };
}

export async function acquireEventFrame(
  ev: MotionEvent,
  download: Download,
  clock: Clock = realClock,
  offsets: number[] = PROBE_OFFSETS_MS,
): Promise<{ frame?: EventFrame; record: ProbeRecord }> {
  const record: ProbeRecord = {
    device_id: ev.deviceId,
    sub_type: ev.subType,
    event_ts: ev.eventTs,
    received_after_event_ms: ev.receivedAt - ev.eventTs,
    attempts: [],
  };
  for (const offset of offsets) {
    const wait = ev.receivedAt + offset - clock.now();
    if (wait > 0) await clock.sleep(wait);
    const t0 = clock.now();
    let attempt: ImageAttempt & { detail?: string };
    try {
      attempt = await download(ev.accountId, ev.deviceId, ev.eventTs, { keepImage: true });
    } catch (e) {
      attempt = { status: 0, step: 1, error_code: 'FETCH_ERROR', detail: (e as Error).message };
    }
    const t1 = clock.now();
    const { image, ...meta } = attempt;
    const check = checkEventFrame(attempt, ev.eventTs, ev.receivedAt);
    record.attempts.push({
      offset_ms: offset,
      sent_after_event_ms: t0 - ev.eventTs,
      latency_ms: t1 - t0,
      ...meta,
      ...(attempt.media_timestamp
        ? { frame_minus_event_ms: attempt.media_timestamp - ev.eventTs }
        : {}),
      ...(attempt.status === 200 && !check.ok ? { rejected: check.reason } : {}),
    });
    // A 200 that fails the check (say, a snapshot before the recording is processed) is
    // retried like a 425: the next attempt may return the recording.
    if (check.ok && image) {
      record.ready_after_event_ms = t1 - ev.eventTs;
      return {
        frame: { jpeg: image, captureTs: attempt.media_timestamp!, origin: 'recording' },
        record,
      };
    }
  }
  return { record };
}

export async function probeFollowUps(
  ev: MotionEvent,
  download: Download,
  clock: Clock = realClock,
  offsets: number[] = FOLLOW_UP_OFFSETS_MS,
): Promise<FollowUpAttempt[]> {
  const out: FollowUpAttempt[] = [];
  for (const offset of offsets) {
    const wait = ev.receivedAt + offset - clock.now();
    if (wait > 0) await clock.sleep(wait);
    const requested = clock.now() - FOLLOW_UP_LOOKBACK_MS;
    try {
      const a: Partial<ImageAttempt> = {
        ...(await download(ev.accountId, ev.deviceId, requested)),
      };
      delete a.image; // the probe never logs image bytes
      out.push({
        offset_ms: offset,
        requested_ts: requested,
        ...a,
        ...(a.media_timestamp ? { frame_minus_requested_ms: a.media_timestamp - requested } : {}),
      });
    } catch (e) {
      out.push({
        offset_ms: offset,
        requested_ts: requested,
        status: 0,
        error_code: 'FETCH_ERROR',
        detail: (e as Error).message,
      });
    }
  }
  return out;
}
