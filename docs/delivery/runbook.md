# Quiet Porch rehearsal and integration runbook

This checkout is isolated from `/home/apexaipc/projects/quiet-porch` and its running service.
The rehearsal performs no Ring, Bedrock, Polly, Home Assistant, SSH, or physical-device calls.

## Continue from another tool

Repository: this `quiet-porch-current` directory. Branch: `feat/quiet-porch-evidence`.
Starting main commit: `487af6468c6672b7d20f0190c48c8b488e569fba`.
Read `docs/delivery/coverage.html`, then inspect current git status before editing.
Source/assets remain in the project. Persistent rehearsal preferences and ledger exports are
in `state/rehearsal/`. Preserve that directory when moving or backing up the project.

## Launch / restart

Node >=22.18 is required. Run `npm ci` if dependencies are missing.

```bash
npm run demo -- --host 0.0.0.0 --port 3472 --state-dir state/rehearsal
```

Open http://10.0.0.46:3472 from the Surface on the same LAN. This address was selected from
ProBook's actual default-route interface. Recheck `hostname -I` if the network changes.
The current preview runs in the separate transient user unit `quiet-porch-rehearsal.service`.
Use `systemctl --user restart quiet-porch-rehearsal.service` to restart this preview and
`systemctl --user stop quiet-porch-rehearsal.service` to stop it. After reboot the transient unit
is gone; run `scripts/rehearsal-service` to start it again, or use the foreground command above.
Do not restart `quiet-porch.service`; that is the older production checkout.

The five scenarios cover a full synthetic night, an active loiterer, no received events,
missing historical outcomes and a ledger-only second synthetic household. Stand down and
expected-person controls only change this rehearsal. Browser report speech is local to the
viewing device, not evidence of Pi/Polly playback. Notes and the selected scenario survive
restarts; fixture replay reconstructs the deterministic simulated ledger.

## Focused validation

```bash
npm test
npm run typecheck
npm run lint
npm run build
node scripts/replay.ts test/fixtures/synthetic-speech-night.json --times 3
```

`npm run build` is the repository's no-emit TypeScript validation: Node runs the TypeScript
source directly. No bundled deployment is implied. The synthetic golden timing expectations
were intentionally updated for Matt's selected 10/20/40-second profile. Legacy bark fixtures
retain explicit `audioMode: bark`; the new speech fixture exercises the selected behavior.

## Prepare an attended test: do not execute from this runbook

1. Physical zone A is `valve.rf_water_timer_valve_1` with duration setter
   `number.rf_water_timer_irrigation_duration_1`, confirmed by a timed tag test on 2026-10-13.
   Re-read both in HA before any valve run; never infer entities from `front_yard` naming.
   There is no exterior light: the example config has no `exteriorLight`, so the ladder skips
   L2. The Pi audio route was verified by attended playback on 2026-10-13.
2. Cam1 is battery powered (Matt confirmed). Live sessions have a 30-second limit. Measure
   Ring capture-time provenance before treating any decoded stream frame as fresh evidence.
3. Read `docs/delivery/live-view-spike.md` and `docs/delivery/capture-time-provenance.md`:
   decoding succeeded in the 2026-10-12 spike, but no absolute capture mapping has been proven.
4. Speech synthesis uses the AWS credential provider chain, through `pollySynthesizer` in
   `src/speech.ts`. Use only credentials needed for an authorized operation; never print them.
   `createSpeechOutput` prewarms both truthful fallback variants, validates finite PCM and
   caches WAV files. `createPiSpeechPlayer` transfers a hashed file and calls `qp-speak`.
   Remote directory `~/quiet-porch/clips` and Pi helpers must already be installed through a
   separately authorized setup. The normal server remains locked to dry run.
   After the helpers, run `scripts/pi/qp-speaker-setup <speaker_mac>` on the Pi once per
   speaker (QP-15). Without it the Anker loses the start of every clip: PipeWire suspends the
   idle Bluetooth sink (~7 s to resume) and the speaker mutes its amp on silence (~2 s to wake).
   It installs a WirePlumber rule and an inaudible 20 Hz keep-alive unit; Stop does not touch it.
5. Speech output accepts at most four seconds; if synthesized audio exceeds that, shorten the
   approved text/slots rather than truncating words. Real Ring-event-to-audio latency (target
   under 3 s) is unmeasured. The 2026-10-13 numbers are components only: Polly synthesis 476 to 880 ms per line, ProBook-to-Pi
   dispatch to playback start 865 ms, `qp-stop` 480 ms (`docs/delivery/validation.txt`).
6. Test duration readback, 30-second valve self-shutoff, Stop, expected-window cleanup,
   unavailable devices, timeout/reconcile and restart in an attended, bounded session.
7. Preserve source evidence privately. Export fixtures outside the public repository with the
   existing exporter, review all identifiers/footage before any public asset is considered.
8. Real account linking, second-household consent/access, real Alexa+ and Ring Playground
   require separate direction. A secondary-household MCP surface must set `accountId` and
   `readOnlyHousehold: true`, exposing only its scoped ledger/report tools.

## Pending decisions

Speech and 10/20/40-second escalation are selected. Two-empty-frame departure and existing
multiple-notification behavior remain; the brief's one-empty-frame/single-alert claims were
corrected. Zone A mapping and the speaker path were resolved on 2026-10-13. Live capture-time
proof, account access, official watermark interpretation and companion-package qualification
remain unresolved.

Configure `primaryAccountId` explicitly before any actual coordinator path is considered.
Absent configuration grants no actuation authority to any arriving account. First arrival
never chooses the owner. A changed persisted primary must be reviewed; mismatches fail closed.
Expected-person windows block new wildlife output too, and starting a window closes active
intruder/wildlife runs. Cancelling/expiry re-enable evaluation; they never resume a cancelled run.
