// Capture-time provenance for decoded live frames (QP-09). A decoded frame carries a stream PTS
// and, sometimes, a GStreamer reference-timestamp meta (RTCP SR or RFC 7273 clock). Only an
// absolute reference from an explicitly trusted clock can become a capture time; PTS and
// receipt time never can. Anything else is labelled 'arrival', which createLiveSource rejects,
// so the incident falls back to the recorded clip.
//
// Current decision (2026-10-12): NO-GO. The authorized Cam1 spike decoded H.264 but saw no
// reference-timestamp meta and no a=ts-refclk / a=mediaclk in the SDP. LIVE_CAPTURE_NO_GO keeps
// every live frame 'arrival' until a bounded run (QP-10) shows a reference clock worth trusting.

export interface DecodedSampleTime {
  ptsNs: bigint | null;
  reference: { clock: string; timestampNs: bigint } | null;
  receivedAt: number; // ProBook clock, ms since Unix epoch
}

export interface CapturePolicy {
  trustStreamReference: boolean;
  trustedClocks: readonly string[]; // GStreamer reference caps, e.g. 'timestamp/x-ntp'
  maxReceiptLagMs: number; // reference older than this at receipt is uncertain, not trusted
  maxFutureSkewMs: number; // reference ahead of receipt by more than this is rejected
}

export type CaptureTime =
  | { authority: 'ring'; captureTs: number }
  | { authority: 'arrival'; captureTs: number; reason: string };

export const LIVE_CAPTURE_NO_GO: CapturePolicy = Object.freeze({
  trustStreamReference: false,
  trustedClocks: Object.freeze([]) as readonly string[],
  maxReceiptLagMs: 2000,
  maxFutureSkewMs: 250,
});

const NTP_UNIX_OFFSET_MS = 2_208_988_800_000n; // 1900-01-01 to 1970-01-01

// GStreamer reference timestamps are nanoseconds; x-ntp counts from 1900, x-unix from 1970.
export function referenceToUnixMs(clock: string, timestampNs: bigint): number | undefined {
  const ms = timestampNs / 1_000_000n;
  if (clock === 'timestamp/x-ntp') return Number(ms - NTP_UNIX_OFFSET_MS);
  if (clock === 'timestamp/x-unix') return Number(ms);
  return undefined;
}

export function deriveCaptureTime(s: DecodedSampleTime, policy: CapturePolicy): CaptureTime {
  const arrival = (reason: string): CaptureTime => ({
    authority: 'arrival',
    captureTs: s.receivedAt,
    reason,
  });
  if (!policy.trustStreamReference) return arrival('reference_not_trusted');
  if (!s.reference) return arrival('no_reference_timestamp');
  if (!policy.trustedClocks.includes(s.reference.clock))
    return arrival('untrusted_reference_clock');
  const ts = referenceToUnixMs(s.reference.clock, s.reference.timestampNs);
  if (ts === undefined || !Number.isFinite(ts)) return arrival('unreadable_reference');
  if (ts - s.receivedAt > policy.maxFutureSkewMs) return arrival('future_reference');
  if (s.receivedAt - ts > policy.maxReceiptLagMs) return arrival('reference_lag_exceeds_bound');
  // A small future skew is clock noise; never report a capture time after receipt.
  return { authority: 'ring', captureTs: Math.min(ts, s.receivedAt) };
}
