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
  synchronized wall clocks. The same deadline applies after SSH, lock wait, preparation,
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
