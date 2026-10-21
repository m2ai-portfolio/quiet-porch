# Bounded attended encounter (candidate; not deployed or live-validated)

The normal service retains its `dryRun: true` parser lock. The separate local runner consumes
only new decisions from the existing ledger, opened read-only. It creates no Ring sessions,
links, credentials, primary-household assignments, or Home Assistant clients. Existing writers
continue unchanged. This is an attended component, not release approval for general live mode.

## Behavior

Default: disarmed. A deliberately supplied private approval policy may grant exactly one
existing claimed/completed account, already bound camera and `front_yard` zone a maximum
60-second session. The runner refuses a different binding, active incident, open reconciliation,
expired policy, KILL/ATTENDED-DISARM file, missing existing notification credentials, Dummy
Output, wrong Bluetooth speaker, muted/zero/over-60% output, or missing native four-second guard.
The approval reference is consumed once on disk, including failed preflight; restarting requires a fresh exact approval reference. No policy or credentials are shipped. Creating a policy requires the owner's approval of this
specific temporary authority. It never sets persistent primary-household status.

Only existing Ring-source decisions with accepted camera evidence enter the controller. The
normal pipeline's intruder decision and household context still apply. Known/expected people,
uncertainty, stale capture timestamps, wrong accounts/cameras/zones, synthetic sources and
repeated evidence do not escalate. Uncertainty or departure ends the session immediately.
Missing fresh evidence for six seconds after encounter start also stops it. This intentionally
fails closed when the current recorded-clip source cannot sustain fresh evidence.

Timing from successive accepted capture timestamps: start, one phone-alert request at 10s,
one cached neutral spoken line at 20s, hold at 40s, hard end at 60s from arming. No light or
sprinkler output exists. No retries occur after failed/ambiguous notification or speech calls.
Exactly one received phone notification cannot be guaranteed across a network: the guarantee
is at most one send attempt per one-shot session; success additionally requires API acknowledgement
and owner observation. Speech is the existing neutral cached line, not generated speech.
The normal multi-level coordinator remains dry-run and retains its existing behavior.

Audit JSONL is private and records scope, evidence IDs/times, intents before dispatch,
acknowledgements, hold and ending/cleanup failure. It contains no tokens or images. These are
separate attended-test records, not invented production incident rows. Existing replay/export
commands do not automatically incorporate this journal; retain it alongside the real Ring clip.
An acknowledgement does not prove audible playback or human receipt.

## Approval and launch (do not execute until readiness and specific scope are approved)

Operator supplies private JSON outside the repo:

```json
{
  "approvalReference": "<fresh exact owner approval>",
  "scope": {
    "accountId": "<verified existing owner>",
    "deviceId": "<verified Cam1>",
    "zone": "front_yard"
  },
  "expiresAt": "<replace with numeric epoch milliseconds, at most 60 seconds ahead>",
  "configPath": "/home/apexaipc/projects/quiet-porch/config/quiet-porch.json",
  "piHost": "rpi-claw",
  "telegramTokenEnv": "<existing approved token environment variable name>",
  "telegramChatEnv": "<existing approved owner destination variable name>"
}
```

The policy is local operator authority, not a cryptographic approval verifier. Keep it private;
do not create one on behalf of the owner. Notification destination must be checked against
existing approved owner records before policy creation. No example supplies a new destination.

```sh
/path/to/node scripts/attended-test.ts --execute --policy /private/approved-policy.json --state-dir /home/apexaipc/.local/state/quiet-porch --attended
```

No service restart is required for this standalone runner. Running it is an arming/actuation
authorization boundary, separate from implementing or reviewing this code. Do not run it merely
to test startup. No-argument invocation fails before opening state or contacting devices.

Emergency disarm: operator Ctrl-C/SIGTERM, or create `ATTENDED-DISARM` in the state directory
(existing KILL also works). The runner aborts pending requests and sends qp-stop. A remote
request already accepted may have acted; it is never automatically retried. The Pi's existing
RuntimeMaxSec=4 independently limits a speech clip if the host or SSH fails. Cleanup failure
requires owner audio inspection; process exit alone is not proof of silence. A stale exclusive
ATTENDED-TEST.lock blocks restart until its process is inspected; never blindly delete it.

## Current blockers / capture truth

Read-only check 2026-10-21 00:29 UTC: Cam1 mapped front_yard, one matching claimed/completed
account binding, no primary household, zero active incidents. No mapping applied.
Pi: known paired/trusted Anker SoundCore suffix 2E:8F disconnected, Dummy Output at 100%.
Existing keepalive targets that speaker; reconnect may route its low-frequency audio.
Connecting, selecting output, adjusting volume and approving test execution remain separate actions.
The intended 45-second continuous camera evidence path is still unverified. Existing live
source reference timestamps remain NO-GO; recorded clips may time out safely before escalation.
Do not weaken freshness, label arrival time as Ring capture time, synthesize evidence, or call
mock success live proof. Current home context requires the existing night window (20:00 CDT).

Before a real run: confirm exact speaker and readiness; confirm gate framing and consenting
volunteer; approve exact temporary account/camera scope and existing phone destination;
prove the real source supplies sustained eligible fresh evidence without weakening guards.
Record actual UTC/CDT start/end, watermarked Ring clip, phone alert recording, private audit,
and independent listening confirmation. If evidence starves, retain that truthful stopped outcome.

Rollback before deployment: remove/abandon this isolated branch; production is unchanged.
After an approved run: disarm and verify idle, retain private audit, remove only the expired
policy after confirming cleanup, and leave normal service dry-run. Do not reset household state
or change another writer. No sprinkler/light restoration is needed because neither is touched.
