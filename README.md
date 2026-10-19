# Quiet Porch

An AI home deterrent for the Amazon Developer Hackathon (Build, Ship, Shape, 2026), Ring and
Alexa+ tracks, with Amazon Bedrock for the AWS Builder mini-challenge.

A Ring motion event becomes a judged, logged decision. A person who is still there at night
gets a calm, escalating response (interior lights, then a descriptive spoken line, then a
sprinkler), and an armadillo in the yard gets the sprinkler. Benign events (deliveries, cars,
pets) get no action at all. Every decision is logged with its frame and timestamps, and an
owner can stand everything down from a signed Stop link or by asking Alexa.

## How it works

```
Ring webhook (signed)
   |
   v
server.ts: verify HMAC, dedupe, log
   |
   v
pipeline.ts
   frames.ts      event frame at the event timestamp, capture time proven by Ring headers
   perception.ts  Bedrock describes the frame (subjects, activity, night IR)
   critique.ts    Bedrock weighs it against household context (mode, routines, visitors)
   decide.ts      deterministic profile: log / intruder / wildlife / reject (stale, no evidence)
   |
   v
coordinator.ts: one active incident, write-ahead intents, cooldowns, cleanup, reconcile
   ladder.ts      L1 interior lights + notify, L2 exterior light (skipped when none is configured;
                  zone A has none), L3 descriptive speech, L4 sprinkler
   allowlist.ts   every Home Assistant call checked; locks, covers and alarms are never allowed
   actuators.ts   Home Assistant REST, Pi speaker, Telegram (or a dry-run simulator)
   |
   v
mcp.ts: status-mcp, MCP 2025-11-25 over Streamable HTTP, for Alexa+:
           get_incident_status, list_recent_incidents, get_night_report, get_ledger,
           expect_me, stand_down, set_mode, clear_reconcile
```

The models never decide timing or act directly: capture time comes from Ring, the profile and
ladder are deterministic code, and escalation needs fresh evidence (stale frames are refused).

## Status

Running live in **dry run**: real Ring events and real Bedrock calls, but every actuator call is
simulated and logged. See [`docs/recon.md`](docs/recon.md) for measured results and
[`docs/plan-v7.md`](docs/plan-v7.md) for the plan and its gates. The validation record, with a
source label on every result, is [`docs/delivery/validation.txt`](docs/delivery/validation.txt).

Not yet verified:

- trusted camera capture timestamps for live view (the live decoder and capture-time mapping are
  unvalidated, so incidents use the recorded event clip);
- real Ring-event-to-audio latency (only component timings are measured, listed below);
- app-driven sprinkler operation, the 30-second valve self-shutoff and recovery;
- a second household;
- final footage and the demo video.

## Run

Requires Node 22.18 or later (TypeScript runs natively), a Ring developer integration, a Bedrock
API key, and Home Assistant for actuators.

```bash
npm install
cp config/quiet-porch.example.json config/quiet-porch.json   # then fill in your devices and URL
cp config/allowlist.example.json config/allowlist.json       # if you need a fresh allowlist
npm test
npm start
```

Environment: `AWS_BEARER_TOKEN_BEDROCK`, plus optional `QUIET_PORCH_PORT`,
`QUIET_PORCH_STATE_DIR`, `QUIET_PORCH_CONFIG`, `QUIET_PORCH_MCP_HOST`, `QUIET_PORCH_MCP_PORT`.
Tokens and frames are kept in the state directory (default `~/.local/state/quiet-porch`), never
in the repo.

The simulated Alexa+ client is `src/alexa-sim.html`, served by status-mcp at `/alexa`.

## How this meets the four judging criteria

What exists today is stated as such, and what does not exist yet is listed after each point.

- **Technological Implementation.** Signed Ring webhooks, `at_timestamp` image download, device
  configuration (`e2e_encryption`), Amazon Bedrock Converse for perception and critique, and an
  MCP server (specification 2025-11-25, Streamable HTTP) for Alexa+. Every ledger time is a Ring
  timestamp and every level carries the age of the frame that earned it
  (`src/ledger.ts`, `src/frames.ts`, `src/mcp.ts`). A recorded night replays through the real
  pipeline three times with the same ledger (`src/replay.ts`). Measured behaviour and friction:
  [`docs/recon.md`](docs/recon.md), [`docs/friction-log.md`](docs/friction-log.md).
  _Not yet:_ Ring live view as the freshness source; the service runs in dry run.
- **Design.** Silent by default; one alert with a Stop link; one ledger line per night event with
  the reason it stopped; a morning report in one breath that never claims an output that did not
  go through (`src/report.ts`); replay and dry run labelled on every page and answer.
- **Potential Impact.** False alarms are the reason people switch motion alerts off. The ledger
  works on any Ring home through the private-app connection, tracks no one across accounts and
  uses no faces. _Not yet:_ a second connected household shown next to the first.
- **Quality of the Idea.** A deterrent judged by its silence: deterministic code escalates only on
  fresh evidence and the model never acts. The line the porch speaks comes from a fixed template
  and a closed vocabulary (`src/voice.ts`). _Speech verified in part:_ Polly synthesized four
  approved lines into a private ProBook cache on 2026-10-13, and Pi playback was heard from a Bluetooth speaker in an
  attended test. Ring-event-to-audio latency is unmeasured, and the service still runs dry run.

## The night ledger

Silence is the product, and the ledger proves it. Every motion event of the armed night is one
line with the Ring capture time, what the camera saw, the level reached, the age of the frame the
level was earned on, the frame source (`clip` today, `replay` for a fixture; `live` and `sandbox` are reserved for live view and the Playground) and why it stopped. A
lingering person is one line for the whole incident, with the age at every level, with known no-action, handled and unknown counts. Missing historical actionable outcomes are unknown, so events = known no-action + handled + unknown. Counts shown in the rehearsal are fixture-derived, not a real-night claim.

```
02:14:07 · person · side gate · L3 (clip) · evidence age 4 s · source clip · stopped: two accepted frames empty 02:14:31
```

- **Morning report.** `get_night_report` (status-mcp, read token) answers "what happened last
  night" in one breath, in dry run it says nothing was switched.
- **Decision-log view.** `get_ledger` feeds the page at `/ledger`; `node scripts/ledger.ts` prints
  the same lines in a terminal from a copy of the live database. `/ledger?video=1` and
  `/alexa?video=1` show the same content at recording size with the token box off screen; set
  the token on the page once without the parameter first.
- **I'm stepping out.** `expect_me` (owner token) opens a window of at most 60 minutes in which a
  person at the door is expected; `expect_me` with `cancel: true` ends it. The ladder stays at L0
  and each event is a ledger line saying `expected`. A running ladder or sprinkler run ends and
  cleans up. Known limits: the window applies to every person event in every zone, so a second,
  unexpected person during the window is also recorded as expected; a frame counts if it was
  captured inside the window (or up to 10 seconds before it was opened).
- **Encrypted cameras.** At startup and every 30 minutes the service reads
  `e2e_encryption.enabled` for each device. An encrypted camera gets no frame request, and its
  events show as `blind: camera video is encrypted`. A frame that is not JPEG bytes is refused.
- **Replay.** `node scripts/replay.ts <fixture.json>` runs a recorded night (webhooks, frames,
  model answers) through the real pipeline on a virtual clock and checks that three runs in a row
  give the same ledger. A replay is labelled `source replay` on every line and in the page header.
  `node scripts/serve-replay.ts <fixture.json>` serves a replay to `/ledger` and `/alexa`
  (read-only, labelled "replay, not live" on both pages and in every spoken answer).
  `test/fixtures/synthetic-night.json` is a hand-built night, labelled synthetic.
  `node scripts/export-fixture.ts` turns a real night from the state directory into a fixture
  outside the repository and prints how the replay differs from the original.
- **Spoken line (selected; dry run).** Matt selected descriptive speech at 20 seconds and the sprinkler at 40 seconds; the 10-second exterior-light step is skipped because zone A has none. `src/voice.ts` composes a fixed, closed-vocabulary line. `src/speech.ts` adds finite Polly PCM/WAV synthesis, cached fallback and failure reporting; `qp-speak` is the Pi integration helper.
  On 2026-10-13 Polly (voice Ruth, generative engine, us-east-1) synthesized four approved lines
  into a private ProBook cache in 476 to 880 ms per line. With the provider forced to fail, cached
  lines were served and uncached lines fell back to the matching cached truthful line. Pi playback
  was verified in an attended test on 2026-10-13. A Raspberry Pi drove an Anker
  SoundCore Bluetooth speaker through the same Pi speech player the app uses (`createPiSpeechPlayer`
  and `qp-speak`). Matt, standing at the speaker, heard the full spoken line after 2 minutes of
  idle. The Pi began playback 865 ms after dispatch from ProBook
  (one recorded run; time until the sound was heard was not measured separately). That test drove the Pi adapters
  directly, not a live coordinator run from a Ring event. Stop was verified on the same hardware. A
  7-second wildlife clip was cut at about 3 s, `qp-stop` returned in 480 ms, a play request dated
  before the Stop was refused and silent, and a 5-second bark clip ran to its natural end with no
  playback process left behind. Both clips are original ElevenLabs sound effects, with no
  copyrighted music. Before the fix in `scripts/pi/qp-speaker-setup`, the Bluetooth speaker lost
  the start of every clip: PipeWire took about 7 s to resume its suspended sink, and the
  speaker took about 2 s to wake its amp after silence. The script installs a WirePlumber rule
  (A2DP pinned, no suspend) and an inaudible 20 Hz keep-alive tone at -40 dBFS. The timings
  above are components (Polly synthesis, Pi dispatch, Stop), not Ring-event-to-audio latency.
  The normal service remains dry run. Legacy fixtures retain explicit bark mode.

Events that were judged actionable but held back (kill switch, cooldown, old evidence) show as
`held`, never as silent; a camera Ring encrypts shows as `blind`. The morning report never claims
a switched output that failed.

Measured frictions with the Ring API, Bedrock and MCP are in
[`docs/friction-log.md`](docs/friction-log.md).

## License

MIT

## Isolated evidence rehearsal

`npm run demo -- --host 0.0.0.0 --port 3472` serves a synthetic-only app with ledger details,
report, simulated Stop and expected-window controls, and durable notes. Open
http://10.0.0.46:3472 on ProBook's LAN (recheck the address after network changes).
No external service or physical device calls occur in this app. Sources and generated assets
live in this repo; preferences/exports persist under `state/rehearsal`.

See [coverage report](docs/delivery/coverage.html), [runbook](docs/delivery/runbook.md),
[submission draft](docs/delivery/submission.html), and [live-view spike limits](docs/delivery/live-view-spike.md).
The normal server still rejects non-dry-run config; the old service/checkout was preserved.

New configured household access requires an explicit `primaryAccountId` in pipeline config.
Without it, all households are ledger-only; arrival order does not grant actuator authority.
Secondary surfaces require `accountId` plus `readOnlyHousehold: true` and expose only scoped
ledger/report tools. No second account was linked by this work. Exterior escalation must match
the incident zone; Stop/close cleanup remains available after context loss.

Live-source signing/session/provenance boundaries are tested, but a real WHEP/RTSPS decoder
and trusted absolute capture-time mapping remain open. Locally received stream frames are
not accepted as timestamp proof. Cam1 is battery powered; session limit is 30 seconds.
Physical zone A is Matt's selected sprinkler deterrent, mapped to `valve.rf_water_timer_valve_1`
with duration setter `number.rf_water_timer_irrigation_duration_1` (confirmed by a timed tag test
in Home Assistant). App-driven valve actuation, the 30-second self-shutoff and recovery are
unverified. The exterior light was dropped, and zone A has none. Two-empty-frame departure and multiple-notification policy remain in place.
