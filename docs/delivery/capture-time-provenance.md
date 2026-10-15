# Live capture-time provenance (QP-09)

**Decision (2026-10-12): no-go for live escalation timing. Clip fallback stays.**
`LIVE_CAPTURE_NO_GO` in `src/capture-time.ts` is the shipped policy: every decoded live frame is
labelled `arrival`, `createLiveSource` rejects it, and incidents use the recorded event clip whose
`media_timestamp` Ring supplies (`src/frames.ts`).

## Why

The six-second freshness gate needs the time the camera captured a frame. What a live decode gives us:

| Signal                                                                      | Absolute?             | Usable as capture time?                                           |
| --------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| ProBook receipt time                                                        | yes                   | No. It includes network, relay and decoder delay of unknown size. |
| Stream PTS                                                                  | no (session-relative) | No. It has no wall-clock anchor.                                  |
| GStreamer reference-timestamp meta (RTCP SR NTP, or RFC 7273 `a=ts-refclk`) | yes                   | Only if present, from a known clock, and inside the bounds below. |

The authorized Cam1 spike (58.478 s total, receive-only) decoded H.264 successfully but recorded **zero**
reference-timestamp meta samples, and the SDP advertised neither `a=ts-refclk` nor `a=mediaclk`. With
no absolute reference there is nothing trustworthy to derive from.

## The derivation, if a reference ever appears

`deriveCaptureTime` (pure, unit-tested) returns `ring` authority only when all hold:

1. The policy explicitly trusts stream references (`trustStreamReference: true`). Off by default.
2. The reference clock is on the policy's allowlist (e.g. `timestamp/x-ntp`). Any other clock is uncertain.
3. Reference is not more than `maxFutureSkewMs` (250 ms) ahead of receipt. Otherwise `future_reference`.
4. Reference is not more than `maxReceiptLagMs` (2000 ms) behind receipt. Otherwise uncertain/stale.
5. The result is clamped so capture time never exceeds receipt time.

Remaining uncertainty even then: an RTCP SR NTP time reflects the **sender's** clock. If the sender is a
Ring relay rather than the camera, it measures relay time, not capture time. Turning the policy on
needs the bounded receive-only run in QP-10 to show a reference is present, monotonic and within bounds
across 30-second battery renewals, plus a reviewed config change.

## Tests

`test/live-decoder.test.ts` covers: the shipped no-go policy, uncertain (no reference, untrusted clock),
stale (lag beyond bound) and future references, NTP/Unix epoch conversion, 64-bit nanosecond precision,
and the end-to-end fallback through `createLiveSource`.
