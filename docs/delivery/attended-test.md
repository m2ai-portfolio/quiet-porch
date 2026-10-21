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
Missing fresh evidence for six seconds after encounter start also stops it. A capture-time gap of six seconds also ends the session even when delivery was prompt. This intentionally
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
  "speakerAddress": "<exact verified existing paired-speaker Bluetooth address>",
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
(existing KILL also works). The runner aborts pending requests and sends qp-stop only if speech may have been dispatched, then requires an idle readback. A failed cleanup is surfaced in final status and a nonzero runner exit. A remote
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

Before a real run: confirm exact speaker and readiness; confirm Cam1 yard framing and consenting
volunteer; approve exact temporary account/camera scope and existing phone destination;
prove the real source supplies sustained eligible fresh evidence without weakening guards.
Record actual UTC/CDT start/end, watermarked Ring clip, phone alert recording, private audit,
and independent listening confirmation. If evidence starves, retain that truthful stopped outcome.

Rollback before deployment: remove/abandon this isolated branch; production is unchanged.
After an approved run: disarm and verify idle, retain private audit, remove only the expired
policy after confirming cleanup, and leave normal service dry-run. Do not reset household state
or change another writer. No sprinkler/light restoration is needed because neither is touched.

## Follow-up validation (2026-10-21)

25 new controller/reader cases and 15 existing pipeline cases pass (40 total). The 16 existing
server regression cases also pass with local socket access; all Ring responses in those tests
are mocked and state is temporary. Project and standalone runner typechecks, changed-file
ESLint and formatting pass. No real runner session, camera fetch, alert or speech was executed.
Read-only speaker check at 00:34:48 UTC confirmed Anker SoundCore connected and selected at
37%, battery 90%, qp-status idle. This supersedes the earlier Bluetooth blocker, not audible
playback validation. Existing approved Quiet Porch phone destination has not been verified;
shared environment variable names alone do not establish it.

## Recorded-frame follow-ups (latest candidate)

The private policy now also requires `"evidenceMode": "recorded-followups"`. After a new
eligible ledger event starts the encounter, the sidecar polls Ring at most every two seconds,
requesting the recorded frame at now minus two seconds. It makes at most 30 image requests
and up to 60 existing Bedrock perception/critique calls; both are bounded and cancellable on
disarm/expiry. It uses the same household context, night window and suppression rules as the
normal pipeline. No snapshot-to-recording relabel, live decoder clock override, manual person
button, fabricated input or media export exists. No images are written by the sidecar.

This is a genuine camera-observation code path, not a manual smoke test. Its real availability
is unproven: the API may not expose a recording quickly enough or long enough, or classification
may exceed the freshness limit. Those outcomes stop the encounter safely. The media header
must say recording, include a trusted capture timestamp close to the requested time, and
advance; both raw and post-classification age must remain under six seconds. A permission
refusal terminates polling rather than retrying. Prior RTSPS capture-time NO-GO is unchanged.

The ledger reader was corrected to accept the actual `ring:<exact device>` evidence source
written by the production pipeline (rather than the nonexistent production `clip` label).
Tests now write the production source format. No production records were changed.

Departure means a valid fresh frame whose validated perception contains no person signal.
Missing, rejected or expired frames are not absence: the terminal reason is a safety timeout
or source failure, never observed departure. A phone send acknowledgement is not one received
notification. The guarantee remains one send attempt, with receipt requiring Matt's phone
observation; speech likewise requires listening confirmation.

Read-only destination lookup at 00:39:51 UTC: existing configured home route is a private chat
named Matt, identifier ending 0203, via Hermes1 (`@m2ai_hermes1_bot`). This is a specific route
for owner confirmation, not authorization inferred from a variable name. No message sent.
Read-only Cam1 metadata: online, encryption disabled, HEVC capability. No footage requested.

Proposed single-use scope: existing completed/claimed owner fingerprint `48178e372779`,
Cam1 fingerprint `b9499d1805b6`, existing zone `front_yard`, paired Anker SoundCore suffix
2E:8F, Matt private phone route suffix 0203. At most 60 seconds from arming, additionally
capped by the policy's absolute expiry. No primary assignment, token issuance, permission
expansion, persistent live flag, service restart, light or water command. Existing service
continues dry-run. The sidecar journal accompanies any real clip; it does not pretend to be
an armed production ledger row or automatically appear in existing replay/export screens.

Smallest proposed output approval (only after volunteer/framing readiness): one attended
session of that exact scope, up to 30 fresh-frame reads through the existing integration and
existing model path, at most one alert to the confirmed private route and one existing cached
neutral spoken line, independent four-second audio guard, stop on departure/failure/disarm
and hard expiry, with no sprinkler or lights. Do not construct/consume the private policy or
run the candidate until that approval arrives. A separate read-only observation session can
establish source readiness first if desired; it has not been run and is not live success.

Latest validation after recorded-frame follow-ups: 87 passing cases (36 new controller,
reader, observer and cancellation tests; 15 pipeline; 20 frame/API; 16 mocked server).
Project and standalone runner typechecks, changed-file lint and formatting pass. No real
media request, output, runner session or production change was used for this validation.

## Scene correction from Matt

Matt confirms there is no gate: Cam1 faces the yard. The staged encounter is a consenting
person approaching into Cam1's yard view, lingering in view for about 45 seconds, and leaving
the view. Departure is still established only by a fresh valid empty observation; loss of
evidence remains a separate timeout/failure. The existing front_yard zone is unchanged.
No gate location, boundary or gate detection is required by the candidate code. The selected
cached clip's SHA-256 filename matches exactly “You're on camera at the front yard.”; it
contains no gate wording. No audio was played to perform this check.
