# Live-view technical spike: software boundary ready, hardware result unverified

Sources inspected October 12, 2026 (America/Chicago):
[Ring API documentation](https://developer.amazon.com/docs/ring/api-documentation.html),
WHEP/RTSPS sections. Session creation uses server-side bearer authentication with an SDP offer;
WHEP creates a session resource and deletion closes it. RTSPS is an alternative transport.
Battery sessions last up to 30 seconds; line-powered sessions up to 60 seconds.

Update: an authorized receive-only Cam1 spike ran on 2026-10-12 (58.478 s
across three sessions). It decoded H.264 but recorded no reference timestamps, so live capture
timing is a recorded no-go and incidents keep the clip fallback. See
[`capture-time-provenance.md`](capture-time-provenance.md). No four-hour hardware spike is
claimed. The text below describes the software boundary as written before that spike.

Implemented in `src/live-source.ts`:

- WHEP signaling adapter with pinned session URL, request timeout and explicit closure;
- RTSPS endpoint construction, without putting credentials in URLs;
- battery/wired session expiration and reopening, source failure recovery, stop cleanup;
- account/device binding and strict monotonic, JPEG, nonfuture, <6-second frame validation;
- arrival timestamps refused; no stale frame retained as new live evidence;
- pipeline injectable frame source with clip fallback, while default service stays on clips.

The unanswered dependency is a decoded frame's trusted absolute Ring capture time. SDP/RTP
and local receipt time are not an absolute Ring capture-time proof. No fake mapping or timestamp
header was invented. A transport implementation must establish that mapping and be separately
reviewed before it can supply `timestampAuthority: ring` frames. WHEP decoder/peer integration
and an authenticated RTSPS decoder remain unimplemented pending this spike; ffmpeg availability
alone is not proof. The code's source boundary is a tested seam, not a working live camera feed.

Target acceptance: samples every 3–5 seconds, age <6 seconds over 40 seconds, reopening the
battery session, clean Stop, honest clip fallback. Until measured, retain L1 cap for the actual
service. A synthetic replay can exercise higher levels, but cannot justify physical escalation.
