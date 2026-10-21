# Quiet Porch staged qualification

Candidate based on `d2bf98e`; isolated branch `fix/yard-qualified-output`.
The ongoing monitor remains stopped. The additive guarded Pi helper was installed during
a separately approved transport test; the candidate was run only as a bounded attended test.

## Behavior

- A typed capture-expiry refusal ends the encounter, verifies cleanup, and retains cooldown.
  Authority loss, emergency disarm, provider failure, ambiguous delivery and cleanup failure
  remain distinct from routine expiry. A matching error-message string is not enough.
- The approved Anker must read back exactly `Volume: 1.00`. Readiness and playback validation
  do not change volume. A separate approved preparation step restores it if needed.
- `qp-speak-guarded` is an additive helper; legacy callers keep their existing helper.
  The ongoing candidate requires the guarded protocol and never silently falls back.
- Readiness supplies the Pi boot ID and CLOCK_BOOTTIME sample. The caller adds remaining
  freshness measured at receipt, conservatively accounting for transport without assuming
  synchronized wall clocks. Dispatch reuses the admission sample, projected forward by the
  local time elapsed since receipt, instead of a second round trip: replay-7 on October 21
  reached speech with 536 ms of freshness, spent 367 ms on a pre-dispatch inspect and was
  refused by the Pi at a 168 ms deadline. The helper still re-checks sink, volume, stop
  epoch and boot ID at dispatch. The same deadline applies after SSH, lock wait, preparation,
  systemd queueing and immediately before the player is launched.
- Both helper stages require the approved speaker identity and 100% readback, pin that
  output, preserve stop-epoch ordering, and keep `RuntimeMaxSec=4`. The wrapper releases
  the audio lock while waiting for the child, so emergency stop can acquire it.
- Acknowledgement establishes OS process launch, not playback completion or human hearing.

## Output-disabled qualification

`scripts/qualify-yard.ts` imports no physical or Telegram output adapters and starts no
subprocess. It reuses the current scope, observer, independent parallel critique, controller,
six-second freshness rule, 10/20-second dwell, emergency checks and cooldown. The model is
pinned to the existing `global.anthropic.claude-sonnet-4-6` in `us-east-1`.

Admission requires a new explicit, expiring policy, stopped live monitor, matching owner/device
binding, valid existing camera authorization, dry-run base configuration, night window,
no active incident/reconciliation, and no active cooldown. Its database is read-only.
It writes only a new isolated evidence directory; production cooldown is read, never updated.

Bounds: 300 seconds for a new signed-ingestion wake, one encounter of at most 60 seconds,
360 seconds overall, 30 image requests, 60 model requests, two-second retrieval deadlines,
four-second model deadlines, and five seconds to drain cancellation. No retries. Frames and
prompts are not retained; diagnostics include image hashes, timestamps and safe response metadata.

All acknowledgements are explicitly simulated. Accepted counts and dwell come from controller
acceptance, excluding pre-arm or otherwise rejected observations. No wake or insufficient person
dwell is inconclusive. An observation pass requires one simulated alert and one simulated speech,
at least 20 seconds of accepted capture-time dwell, at least 1000 ms remaining freshness at the
simulated speech decision, bounded calls and drained requests. Speaker readiness, actual dispatch
cost, classification ground truth and physical delivery remain unqualified by this run.

Example policy (fill only for an approved run; this template is deliberately expired):

```json
{
  "operation": "output-disabled-yard-qualification",
  "approvalReference": "owner-approved-staged-plan-20261021",
  "expiresAt": 0,
  "scopePath": "/home/apexaipc/Documents/Codex/2026-10-12/task/quiet-porch-private/ongoing-yard-monitor/scope.private.json",
  "modelId": "global.anthropic.claude-sonnet-4-6",
  "region": "us-east-1",
  "durationMs": 360000,
  "wakeAdmissionMs": 300000
}
```

With the existing AWS runtime credentials supplied only in process environment:

```bash
node scripts/qualify-yard.ts --observe-authorized --policy APPROVED.json --output NEW_DIRECTORY
```

## Validation and remaining gates

The initial candidate passed 146 targeted Vitest cases across 11 files, including a wrapper
executing 18 offline Python helper cases. TypeScript checks cover source/tests and separately
the changed executable scripts. Repository lint and `git diff --check` pass. A sandbox Python
spawn restriction required rerunning the helper fixtures outside the sandbox; that was not
a hardware or application failure. All external commands in those fixtures are mocked.

After two approved idle runs, an event arrived after the original two-minute admission window.
The isolated qualification runner now allows five minutes to receive a new wake, with six minutes
overall. This requires a new approval policy explicitly matching both duration fields; the old
three-minute approvals cannot authorize it. Capture freshness, observed dwell, one encounter and
all camera/model request limits are unchanged. A focused delayed-wake fixture covers this case.

The guarded Pi helper was installed during the separately approved transport test. Telegram
receipt was owner-confirmed. Bluetooth reconnect alone produced a stutter; after the owner
power-cycled the Anker and its reset volume was restored to 100%, the owner heard the full
cached sentence clearly. The exact audio fault is still unknown. These are separate transport
results, not an end-to-end camera encounter. All three output-disabled runs were inconclusive.

## Bounded attended delivery test

`scripts/deliver-yard-once.ts` is a separate explicit entry point using the same bounded core.
The observation-only wrapper cannot select real outputs. A fresh, expiring, single-use policy
pins the camera scope, existing model and route, private Telegram recipient fingerprint,
Anker fingerprint, cached clip, and exact request/output limits. The policy template is expired.

The runner acquires its own ATTENDED-TEST lock, excludes the ongoing monitor, then reads
shared cooldown. A real encounter reserves shared cooldown before any possible output.
Only newly ingested wakes qualify. It preserves six-second freshness, independent critique,
10/20-second observed-person dwell, disarm/kill checks and one encounter of at most 60 seconds.
Limits remain five minutes waiting, six minutes operational time plus five seconds to drain,
30 image retrievals/up to 60 Ring HTTP requests, 60 model calls, one Telegram and one cached
1.96-second speech with a four-second hardware cap. It never activates an ongoing service.

Attempts and transport acknowledgements are distinct. Telegram failure prevents speech;
ambiguous outputs are never retried. Camera, model and output promises are tracked through
cancellation. Cleanup failure fails the run; undrained work or unconfirmed cleanup retains
exclusion for explicit recovery. Cooldown is never cleared by the runner.

The new bounded-delivery checks passed 64 focused tests across four files. Source/test and
both CLI typechecks, changed-file lint and whitespace checks pass. Astra reviewed the final
cleanup, exclusion, cooldown and simulation-isolation paths with no remaining blocker.
One approved real encounter ran on October 21, 2026, from 02:38:57 to 02:40:33 CDT.
A signed Ring wake arrived at 02:40:28. Speaker readiness passed in 378 ms. The first image
retrieval returned HTTP 416; the next returned one image in 493 ms. The independent critique
succeeded in 2,250 ms, but person assessment returned Bedrock HTTP 503 after 2,328 ms.
The image was 4,823 ms old at failure, below the six-second freshness limit.

The run ended with zero accepted observations, zero Telegram attempts and zero speech attempts.
Cleanup succeeded, all requests drained, and cooldown was retained. The post-run check found
base ingestion active, the ongoing monitor stopped, no test/monitor lock, and the Anker idle
at 100%. The upstream cause of the HTTP 503 remains unknown. This was a failed end-to-end
attempt, not a successful delivery test. No footage or raw private journal is included here.

The run's approval is consumed. A further attended encounter requires fresh approval for
private Ring imagery and bounded Telegram/speaker outputs. Success still requires the expected
Telegram and owner-heard speech from the same encounter. No model/routing change, IAM change,
sprinkler or light output is included. The owner ended testing for the night.

## Expiring attended daylight test

The one-shot policy optionally includes `daylightTest: { startsAt, expiresAt }`, with a
maximum six-minute interval bounded by the policy expiry. Without it, normal night-only
admission remains. With it, expiry ends authority even if the regular night window begins.
The test uses an audited in-memory `away` context so a daytime person can qualify; persistent
household configuration, visitor/routine vetoes, actual capture times and the night window
are preserved. Daytime wildlife remains excluded. Ongoing monitoring is unchanged.

The one-shot speaker transfers the shorter of remaining capture freshness and remaining
policy authority to the Pi. The existing remote helper checks that deadline after queuing,
preventing speech from starting after the test expires. No physical output is retried.
Focused checks cover default-night behavior, daytime admission, config preservation, expiry
during readiness/judgement/delivery, and remote launch delayed past expiry.

## October 21 daylight repeat

The owner-approved repeat listened from 10:02:43 CDT, armed on a real Ring wake about
10:03:03 and stopped at 10:03:20. It retrieved five images and made ten model calls. The
first frame's pair finished 107 ms past the six-second limit and was rejected. Three
accepted person observations then established 6,936 ms of capture-time dwell, below the
10-second alert threshold. The fifth frame's perception call returned HTTP 503 at 4,781 ms
image age while critique returned 200, which ended the encounter. There were zero Telegram
or speech attempts; cleanup and drain succeeded. Real event delivery and accepted person
observations are shown. Output delivery is not.

## One-shot new-frame recovery after a model 503 or a stale result (offline candidate)

A delivery policy may add exactly one of two recovery shapes; any other shape, including
the earlier `{ modelUnavailable503: 1 }`, is refused:

- `{ newFrameRecoveries: 1, causes: ['model_unavailable_503'] }`
- `{ newFrameRecoveries: 1, causes: ['model_unavailable_503', 'model_result_stale'] }`

Without it, behavior is unchanged. Both causes share one recovery per run: whichever fails
first spends it.

**503 cause.** The parallel judgement settles both
calls for a frame before reporting. A typed Bedrock HTTP 503 aborts the frame's other call,
and the failure becomes `ModelUnavailableBreak` only when that call settled successfully,
was cancelled by us or also returned 503. The runner then waits up to one second for every
camera/model request of the observation to settle. If the same encounter is still armed and
authorized, it calls `restartDwell`.

`restartDwell` discards continuous dwell and sets a floor at the failed frame's capture time,
so neither that frame nor anything older can start the next segment. Encounter identity,
the 60-second deadline, seen evidence, alert/speech flags, request counters and cooldown
are untouched, so an alert already sent is never repeated. The run summary follows the same
segments: `max_dwell_ms` is the longest single segment and is never bridged across a reset.
A second 503, a different sibling failure, undrained work, revocation, kill, cancellation or
expiry stops the run as before. Freshness stays at six seconds.

**Stale cause.** Only a judgement that completed but came back six seconds or more after
capture counts. A frame already too old or repeated when it arrives is not covered, and a
reversed clock is never treated as stale. The observer asks the runner first; it raises
`StaleResultBreak` only when the stale cause is listed, the recovery is unspent and the
encounter has started a dwell segment. A late result before any dwell exists (as in the
October 21 daylight repeat's first frame) therefore leaves the recovery unused. Otherwise
the late result is dropped silently exactly as before and the encounter ends on its own
`evidence_lost` rule. A stale result never becomes evidence and never becomes a fault,
including when the controller refuses the restart because evidence is already lost. The
`dwell_reset` row and the run summary (`recovery_cause`) record which cause was used.

## Office test labeling

A policy may add `testSetting: 'office'`. It is applied only in memory, and only while the
policy is active. The critique prompt then states that the camera is temporarily indoors
and that the zone is its configured name. Since office attempt 5's candidate it also states that
being indoors, a missing yard scene or a zone-name mismatch is never a reason for `uncertain`,
and that the normal verdict rules apply to whoever is visible (see office attempt 4). The Telegram text says it is a supervised OFFICE
test. The context audit row records the setting and marks the cached front-yard sentence as
a playback fixture. The persistent camera binding, zone mapping and household configuration
do not change. The perception prompt is unchanged. The office wording was first sent to the
model in office attempt 2 (below); its effect on the critique is not yet explained.

An office policy may also set `speakerVolume` (two decimals, above 0 and at most 1). Speaker
readiness then requires exactly that readback instead of 100%, so drift from it still
refuses; the speaker ceilings are unchanged. Any other policy carrying it is refused. The
first office launch on October 21 stopped at readiness with the Pi reading 36%, before any
image, model, Telegram or speech request; Matt then accepted 36% for indoor tests.

Focused checks: `test/model-unavailable-recovery.test.ts` (28 cases before reason logging) covers renewed 10/20 s
dwell, recovery after an alert without a second alert, a second 503, sibling timeout/parse/500
failures, an untyped "503" message, a sibling that ignores cancellation, revocation, kill,
cancellation and expiry during the drain, a repeated failed frame, the unchanged 60 s deadline
and counters, segment-only summary dwell, the default-off path, policy shapes and office labels.
The stale cases cover a stale result mid-encounter (one alert, one speech, the stale frame
never evidence), a stale result before the encounter (recovery left for a later 503), the
503-only policy matching no recovery event-for-event, a 503 then a stale result, a stale
result then a 503, a refused stale restart, and the observer's reversed-clock and
absent-predicate cases. A mutation sweep of the stale guards killed 13 of 15 single
mutations. The two survivors are second-layer checks in the runner's `recover` whose first
layer (the observer's stale predicate, and the 503-only sibling settling) blocks the same
input; removing each together with its first layer was killed.

## October 21 office attempt 2

The second office launch armed on a real Ring human wake at 11:15:24 CDT with the speaker
reading 36%. Two frames were judged fresh (5,485 and 5,418 ms at completion). The critique
returned `uncertain` for both (`decision: log`, `reason: critique_uncertain`), so the
encounter ended uncertain. There were no 503 or stale results, zero Telegram and zero speech
attempts; safety, cleanup and drain passed. The journal kept only the verdict label, so the
cause of the uncertain critique cannot be determined from that run.

## Judgement reasons in the private run journal (offline candidate)

The attended observer takes `recordJudgementReasons`, off by default, so ongoing monitoring
rows are byte-for-byte unchanged. The bounded runner turns it on. Every judged-frame row then
carries two objects built from the raw parsed model output, each re-checked field by field:

- `perception`: `person_present` and `night_ir` (booleans only), `activity`, and at most five
  `subjects` whose class is in the fixed list and whose confidence is a number from 0 to 1.
- `critique`: `verdict` (only a listed verdict), `person_present` (boolean only) and at most
  five `reasons`.

Rows covered: `followup_observation` (including an `independent_judgement_disagreement`
rejection) and the `model_result_stale` `followup_rejected` row. Strings are read only from
data properties (getters are never invoked), cut to 2,000 characters before any pattern runs,
then: line breaks become spaces, other control, zero-width and bidi characters are removed,
URLs and data URIs and token-like runs (24+ key characters, AWS key ids) become `[redacted]`,
whitespace is collapsed, and the result is cut to 160 code points. Non-strings and empty
strings are dropped. No image bytes or base64 are written. A failure reading one half leaves
the other. Rows go only to the private `observations.private.jsonl`; `summary.json` and
`result.json` are unchanged.

Focused checks: `test/judgement-reasons.test.ts` (10 cases: truncation, controls, redaction,
type filtering, caps, hostile getters, option off and on, disagreement and stale rows) and one
bounded-run case in `test/model-unavailable-recovery.test.ts` (reasons on observed and stale
rows, no pixels). A mutation sweep of the sanitizer, the option and the runner wiring killed
24 of 24 single mutations.

## October 21 office attempts 3 and 4

Attempt 3 armed on an `other_motion` wake (received about 11.4 s after the event). Ring
answered `416` to all 28 frame requests until the 60-second session expired, so no model call
was made (F-01, F-02). Zero Telegram and speech; cleanup and drain passed.

Attempt 4 armed on a `human` wake at 11:45:59 CDT with reason logging on. Frame 1 (person
0.98, critique `unknown`) was captured before arming and rejected as designed. Frame 2 (person
0.99, fresh at 5,620 ms) got critique `uncertain`, which ended the encounter. The journaled
critique reasons were "indoor office environment visible not a yard scene", "camera
configured as front_yard but currently indoors per supervised test note" and "cannot assess
outdoor context from this frame": the office note itself led the critique to abstain.
Perception also reported `night_ir: true` on both daytime indoor frames. Zero Telegram and
speech; cleanup and drain passed.

The office note now tells the critique that the indoor setting is never grounds for
`uncertain` and to apply the unchanged verdict rules to whoever is visible. The check in
`test/model-unavailable-recovery.test.ts` asserts the new sentences, that they precede the
verdict rules, and that removing the two office lines leaves exactly the non-office prompt.
The effect on a live critique is untested until the next office attempt.

## October 21 office attempt 5

With note v2 the critique returned `unknown` on 5 of 6 judged frames. Three perception results
came back too old (6,087, 6,334 and 6,093 ms at completion, perception 3,395 to 3,559 ms); the
run's one recovery was spent on the first. The last frame's critique returned `benign`
("consistent with household member routine"), which ended the encounter without an alert.
Zero Telegram and speech; safety, cleanup and drain passed. Over 287 server perception calls
since October 7 the median is 2,685 ms and the 90th percentile 3,589 ms; 18% take 3.3 s or more
and slow calls come in runs of up to 5. Critique stays at 2.0 to 2.4 s.

## Per-call token usage in the private run journal (offline candidate)

Diagnostic only: no prompt, threshold, freshness limit, recovery or output changes. After a
JSON body is read, the Bedrock client calls `onResponse` a second time with the provider's
`usage` and `stopReason`, before the empty-text check, so a `max_tokens` answer still reports
it. The judgement adds `input_tokens` and `output_tokens` (whole numbers from 0 to 1,000,000)
and `stop_reason` (only `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`,
`guardrail_intervened` or `content_filtered`) to `model_completed` rows, and to `model_failed`
rows after a body was read. Values are read only from data properties; anything else is
dropped. Every other row field is unchanged. Rows go only to the private
`observations.private.jsonl`.

Focused checks: two cases in `test/bedrock.test.ts` (callback order, usage on an empty
answer), two in `test/monitor-diagnostics.test.ts` (sanitizer bounds and hostile values; the
exact `model_completed` row) and one bounded-run case in
`test/model-unavailable-recovery.test.ts` (the real client over a fake transport puts token
counts on every completed call). A mutation sweep killed 15 of 15 single mutations.

## Bounded office session and labelled delivery replay (offline candidate)

Two new owner-approved modes, each with its own single-use approval through the same ledger and
`ATTENDED-TEST.lock` as the one-encounter test. Neither changes a per-encounter limit, the 6 s
freshness gate, the 10/20 s dwell gates, recovery, or the durable cooldown. The one-encounter
policy, validator and `scripts/deliver-yard-once.ts` are unchanged.

**Session** (`bounded-attended-session`, `scripts/deliver-yard-session.ts`): one approval covers
an office session starting within 15 minutes and lasting at most 60, with up to 3 encounters,
session totals of 90 frames, 180 model calls, 1 Telegram message and 1 speech. It runs the
unchanged `runBoundedYard` once per slot. A slot starts only after `startsAt`, after the shared
cooldown, and only if it can finish (wake admission, encounter, drain) before expiry. A quiet
slot consumes no encounter. The session stops at the first alert or speech attempt, after 3
encounters, at the totals, at expiry, on KILL, authority loss, cancellation, or any slot that
is not a clean result. It never restarts itself.

Re-arm differs from the design note: every encounter already reserves a durable 10 to 11 minute
cooldown (`yard-monitor.ts`), so the next encounter starts after that cooldown, not 30 s
later; shortening it would have loosened a safety limit. Wakes stamped before the previous
encounter ended are logged and never admitted. The journal adds `session_waiting` once a
minute (with time since the last wake), `session_wake_seen` per wake, and a summary with
`slots`, `encounters`, per-encounter outcomes, `wakes_seen` and `longest_quiet_ms`, so a camera
that stops detecting is visible from the run directory alone.

**Replay** (`labelled-delivery-replay`, `scripts/deliver-replay-once.ts`): one approved
recorded Ring person still (`ring-door-person`, `ring-person-garden` or `ring-person-car`,
pinned by SHA-256) through the real judgement, Telegram and Pi speaker, with no camera call:
the CLI imports no Ring client and never reads camera tokens. One synthesized wake is logged as
such; every served frame is the same still stamped with its request time and logged with its
hash, so it is about 2 s old when served and slow judgement is still rejected as stale. The
Telegram text starts with `REPLAY of <fixture> (not live)`. A replay proves the delivery chain
only, not live wake, camera media or real dwell; dwell from a held still is a replay artifact.
It respects and reserves the shared cooldown like a live run.

Focused checks: `test/attended-session-policy.test.ts` (every bound accepted at the limit and
rejected one past it; the three operations never validate as one another; window-only
authority and context), `test/attended-session.test.ts` (start wait, quiet slots, cooldown and
re-arm, first output, totals including a swallowed cap error, faults, KILL, authority loss,
cancellation, and the real engine across an empty encounter, the cooldown and one delivery)
and `test/delivery-replay.test.ts` (fixture bytes, one wake, request-time stamps, the real
engine to one alert and one speech, stale rejection, no camera reach). A mutation sweep killed
33 of 33 single mutations. Private launcher: `launch-hands-off.py session|replay`.
