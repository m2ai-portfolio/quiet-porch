# Plan v7: Quiet Porch, AI home deterrent (intruder ladder + nuisance wildlife)

Supersedes plan v6 (`~/.claude/checkmate/runs/2026-09-27-1021-ai-home-deterrent-v5/plan-v2.md`).
Goal card: `docs/goal.md` (Q-20261007-0001). Checkmate consensus 2026-10-07, run `2026-10-07-1530-quiet-porch-plan-v7` (3 rounds). Revised 2026-10-07 after Matthew's correction:
"We shouldn't be removing the original functionality of what this system was designed to do.
The armadillo is just a test scenario, not the only thing it can do."

## Goal

Ship a working, demo-recorded Devpost entry by 2026-10-20 (hard stop 2026-10-23 12:00 PT) in
which a Ring motion event is perceived by AI on the frame from the event's own moment, benign
events cause zero actions, and two response profiles run on the same pipeline:

1. **Intruder profile (v6, kept):** a persistent unknown person at the perimeter triggers a
   bounded, non-harmful, exterior-only escalation ladder while the interior stays silent, with
   an owner stand-down at every level and a calm voice status report afterward.
2. **Nuisance wildlife profile (new):** a confirmed armadillo (or another configured species)
   at night triggers a 30 s sprinkler run, chosen interior lights, a short clip on the outdoor
   speaker, and a Telegram message with the frame and a Stop link.

The armadillo is the live test scenario for profile 2. A staged loiterer is the test scenario
for profile 1.

## Verified facts (this session or `docs/recon.md`)

- Ring (counted 2026-10-07 15:35 CDT from `webhook-events.jsonl`): 73 signed webhooks, 69 of
  them `motion_detected`, 0 rejected. Attributes are exactly
  `source`, `source_type`, `timestamp`, `sub_type`. Ring Cam 1 sent only `human`; Front Door
  only `motion` (Smart Alerts off there). Token refresh at 75% of lifetime works.
- `at_timestamp` at the event time returns the event's own frame (`X-Media-Origin: recording`).
  First live probe (2026-10-07 15:17, Ring Cam 1): `200` on the first request, frame 0 ms from
  the event, usable 1.94 s after the event. One sample; `frame-probe.jsonl` keeps logging.
  `latest_in_range` returns the END of the window, and an old snapshot can come back
  (1091 s old on 10-06), so it is not used for freshness.
- Bedrock Converse (`global.anthropic.claude-sonnet-4-6`, bearer auth): day frame in about
  2.4 s; JSON comes inside a code fence and `parseModelJson` handles it.
- HA facts below were read live via REST `/api/states` and `/api/config` on 2026-10-07 between
  15:19 and 15:25 CDT and are recorded in `docs/recon.md` ("HA inventory"); they are
  observations at that time and are re-read at each gate.
- Home Assistant 2026.9.4 at `HASS_URL` answers with `HASS_TOKEN` (231 entities). The
  `mcp_server` integration is NOT loaded. Integrations include `tuya` and `alexa_devices`.
- HA actuators, all Tuya and all currently `unavailable` (Tuya link broken):
  `valve.front_yard_sprinkler_valve`, `valve.backyard_sprinkler_valve`,
  `number.*_irrigation_duration` (0 to 86400 s), 14 lights, `switch.patio_light_socket_1`,
  `switch.back_patio_socket_1/2`.
- HA sensors: `binary_sensor.motion_sensor_1b3a_motion` (battery 20%) and
  `binary_sensor.motion_sensor_4c16_motion` (battery 0%), placement unknown. The Aqara hub M2
  and its `binary_sensor.motion_sensor` are `unavailable`. Aqara FP2/P1 appear only as
  `button.*` Alexa routine triggers, not as presence sensors. No Wyze entity exists.
- HA media players: Echo devices (interior) and TV/receiver. None for the outdoor Anker.
- Anker outdoor speaker on rpi-claw: bonded, default PipeWire sink, auto-reconnects after a Pi
  reboot and a speaker power-cycle (`anker-reconnect.service`), `pw-play` over SSH works.
- Telegram bot tokens and chat ids exist in `~/.env.shared`.
- Repo `~/projects/quiet-porch`: `allowlist.ts` (forbidden lock/cover/alarm domains, safety vs
  escalation class from the service name, interior audio deny), `db.ts` (events, evidence,
  one-active-incident index, cooldowns, write-ahead `action_intents`, `reconcile`),
  `bedrock.ts`, `ring.ts` with `downloadImageAt`, frame probe live. 54 tests pass.

## Architecture (TypeScript, Node 22, repo `quiet-porch`)

```
Ring webhook (signed) ──> ingest ──> events (unique source_event_id)
HA motion sensors (WS) ─┘                │
                                         v
                         frame acquisition (Ring adapter owns timestamps)
                                         │ evidence row (evidence_id)
                                         v
                         perception (Bedrock): subjects[] with class + confidence
                                         │
                                         v
                         critique (Bedrock): benign | uncertain | unknown | suspicious
                                         │
                         ┌───────────────┴───────────────┐
                         v                               v
              intruder profile (ladder)        wildlife profile (one-shot)
                         └───────────────┬───────────────┘
                                         v
                         coordinator: one incident, write-ahead intents,
                         serialized dispatch, allowlist check, reconcile
                                         │
                  HA REST adapter   pi_audio adapter (ssh pw-play)   Telegram
                                         │
                         status-mcp (Alexa+): status, stand_down, set_mode
```

### 1. Ingest

- Existing `/ring/webhook` route on the Funnel. HMAC verified; dedupe by `meta.request_id` and
  by `data.id` into `events`; reject events whose `attributes.timestamp` is more than 5 min old.
- Ring `sub_type` is a hint, never a filter: every motion event goes to perception.
- HA WebSocket subscriber for secondary motion sensors, used only for the disagreement rule
  (item 4) and only for zones whose covering sensor is declared in config and has a working
  battery.

### 2. Frame acquisition (Ring adapter owns timestamps, never the model)

- **Event frame:** `at_timestamp` at the event's `attributes.timestamp`, retried at +2 s and
  +5 s after receipt on `425`. Accepted only if all hold: HTTP 200 with `image/jpeg`;
  `X-Media-Origin: recording` (a `snapshot` is rejected however fresh); `X-Media-Timestamp`
  present, finite, and within 1000 ms of the event timestamp (observed: 0 ms Ring Cam 1,
  611 ms Front Door); and not later than our receipt time. Anything else is no evidence.
- **Follow-up frames for dwell (intruder profile):** a fresh frame every 5 s while an incident
  is open. Source A: `at_timestamp` at (now - 2 s) while the camera is still recording; valid
  only if `X-Media-Origin: recording` and `X-Media-Timestamp` is within 5 s of the requested
  time. Source B (only if its gate passes): live stream (WHEP/RTSPS) with capture time from the
  RTCP sender-report wallclock and a measured buffering bound under 3 s. Neither passes: the
  ladder stops at L1 and the gate table says so.
- A frame with no provable capture time is invalid (fail closed). Every accepted frame gets an
  immutable `evidence_id` (zone, source, capture time, image sha256).

### 3. Perception and critique (Bedrock)

- Perception output, schema-validated, `evidence_id` must match the input:
  `{evidence_id, subjects: [{class: person|armadillo|cat|dog|opossum|raccoon|deer|vehicle|other,
confidence}], person_present, activity, zone, night_ir}`.
- **Person evidence is derived, not trusted (deterministic, after schema validation):**
  `person_signal` = `person_present` OR any `person` subject with confidence >= 0.30.
  Contradictions are malformed evidence (no action): `person_present` false with a `person`
  subject >= 0.30, or `person_present` true with no `person` subject.
- **Confidence tiers for people:** `person_detected` = a `person` subject with confidence
  >= 0.80. `person_uncertain` = `person_signal` without `person_detected`.
- Critique compares perception with the context store (routines, known pets, sprinkler
  schedule, expected deliveries, time of day, mode `home|away|night`) and outputs
  `{verdict: benign|uncertain|unknown|suspicious|nuisance, reasons[]}`. `uncertain` means the
  critique cannot decide. `nuisance` means a configured nuisance species is present and not a
  known pet or expected animal.
- **Global rule first:** critique `benign` is log only, for every profile, whatever the
  perception confidence.
- **Profile choice (deterministic):**
  - `person_uncertain`, or critique `uncertain`: log only. Zero actuator calls and no owner
    notification (goal card: "anything uncertain ... only logged").
  - `person_detected` with `benign`: L0, log only.
  - `person_detected` with `unknown` or `suspicious`: intruder profile.
  - Wildlife profile only if ALL hold: no `person_signal`, a configured species with
    confidence >= 0.80, critique verdict exactly `nuisance`, inside the night window.
  - Any `person_signal` blocks the wildlife profile on that `evidence_id`.

### 4. Evidence rules (both profiles)

- Missing, stale, malformed, or low-confidence (< 0.6) evidence never advances anything; it
  holds the current level. Three consecutive bad-evidence cycles or the global timeout exit the
  incident. Ring auth failure mid-incident counts as missing evidence.
- Evidence binding: perception, critique and every action proposal carry the `evidence_id`
  they came from. Before any level advance and before each escalation call, that evidence must
  be under 15 s old and the newest evaluated evidence for the zone. Superseded results are
  discarded.
- Sensor disagreement (intruder profile): if a declared covering sensor, read under 10 s ago,
  reports no motion while perception reports a person, the incident is in `disagreement`: owner
  notified, no actuator, no advance, until agreement or timeout. Zones with no working covering
  sensor rely on Ring alone (today: all zones, until sensor placement is confirmed).

### 5. Intruder profile: ladder (from v6)

Dwell = continuous person presence in fresh frames in the same zone. A gap over 10 s between
valid frames, or a valid frame with no person, resets dwell to 0 (level held, not advanced).

| Level | Entry                                 | Actions                                                                       | Limits                                                                                                        |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| L0    | verdict benign                        | none, log only                                                                | n/a                                                                                                           |
| L1    | person_detected AND unknown/suspicious | owner notification with stand-down; interior lights in a room sequence        | lights revert after 15 min; no interior audio, TV visual-only dropped (no confirmed mute read-back available) |
| L2    | dwell >= 20 s                         | exterior light on toward zone (`switch.patio_light_socket_1` or a substitute) | max 10 min, auto-off                                                                                          |
| L3    | dwell >= 40 s                         | one finite 5 s synthesized bark clip on the outdoor speaker                   | no loop; max 3 clips in 60 s; Pi-side volume cap                                                              |
| L4    | dwell >= 60 s AND mode away or night  | sprinkler zone covering the subject                                           | only if the valve's own duration limit is verified (gate); duration set to 30 and read back before open       |

Exits: departure (no person in 2 consecutive fresh frames), benign reclassification,
stand-down, global timeout 5 min, or restart (boot closes open incidents and sweeps exterior
actuators off). Intruder cooldown 10 min per zone after exit, persisted per (zone, profile).
A frame that is `person_uncertain` during an open incident counts as bad evidence (holds the
level, never advances it).

### 6. Wildlife profile: one-shot (new)

- Night window 20:00 to 06:30 local (Matthew, 2026-10-07). Outside it, log only.
- On a confirmed species in a zone with a mapped valve (Ring Cam 1 -> `front_yard`, coverage
  to be confirmed): set `number.front_yard_sprinkler_irrigation_duration` to 30 and read it back
  as 30, then `valve.open_valve`; interior lights on (revert after 5 min); one pinned clip on the
  outdoor speaker; Telegram `sendPhoto` with the frame, verdict and a Stop URL button.
- At +40 s, read the valve back closed; otherwise alert and open a reconcile row.
- Same coordinator, intents, allowlist and kill switch as the intruder profile. Wildlife
  cooldown is its own row: 10 min per (zone, `wildlife`).
- **Preemption by an intruder (atomic):** in ONE SQLite transaction, the wildlife incident
  becomes `cancelled` with `exit_reason = 'preempted'` and the intruder incident is inserted
  (`profile = intruder`, L0 evaluation). The one-active-incident index holds throughout. The
  new incident's queue starts with the wildlife cleanup as safety commands (close valve, stop
  audio, lights back). A wildlife cooldown never blocks intruder evaluation; only an intruder
  cooldown on that zone does. If cleanup fails, the entities get reconcile rows (inhibited from
  escalation) and the intruder ladder continues without them.
- An armadillo event during an open intruder incident is logged only.

### 7. Coordinator (from v6, applies to both profiles)

- One active incident globally, bound to one zone (unique partial index, already in `db.ts`).
  Events from other zones are logged and notified, never inherited.
- Write-ahead intent row before every actuator call; marked `done` only on a confirmed result.
  On boot, every pending intent becomes a `reconcile` row before any event is accepted.
- **Correlation contract (schema change in `db.ts`):** `action_intents` gets a local
  `intent_id` (uuid, unique, written before dispatch). `ha_context_id` becomes nullable and is
  filled only from what HA returns for that call (the HA WebSocket `call_service` result
  context, or the context on the changed states in the REST response); the plan never invents
  one. Outcomes: `done` (context captured, state read back), `unknown` (timeout, crash, or
  disconnect before a response). An `unknown` intent always opens a reconcile row with a null
  context id.
- Late-command attribution for a null-context row: the adapter subscribes to HA
  `state_changed` events. A state change on that entity after `dispatched_at`, whose context
  `user_id` is the `quiet-porch` HA user, is treated as possibly ours: the watcher sends the
  safety command and reads back. A null-context row never resolves on time or read-back alone:
  it stays open, the entity stays inhibited from escalation, and its watcher stays active
  (restored on restart and HA reconnect) until the owner clears it. HA documents no maximum
  late-delivery bound, so the plan assumes none.
- Serialized dispatch through one queue; each call re-reads the incident version and aborts on
  change. Stand-down, exit and reclassification jump the queue: cancel, drop queued actions,
  wait at most 3 s for the in-flight call, then send off/close/stop to every actuator the
  incident touched and read back, retrying up to 3 times. Cleanup completes within 15 s or the
  owner is alerted.
- Every actuator call has a 3 s deadline. Actions are single immediate service calls (no HA
  scripts with delays).
- Reconcile rows (unknown outcome or failed off read-back) inhibit the entity from escalation,
  re-send off on any transition to on, and run a periodic check every 30 s backing off to 5 min,
  restored on restart and HA reconnect. A row with a captured context id resolves when HA shows
  that context landed and the entity has since read back off; a null-context row resolves only
  by owner clear; the owner can always clear any row. Owner override
  uses a dedicated HA user `quiet-porch` for all app calls; only configured owner user ids clear
  a row.
- Command classes: escalation (on, open, play) obeys every guard; safety (off, close, stop,
  cancel, reconcile, boot sweep) bypasses evidence-age, disagreement and version guards and is
  always allowed on allowlisted entities.

### 8. Action adapters

- **HA adapter** (HA has no `mcp_server` loaded, so no HA MCP path): every call goes through
  `checkAction` first.
- **Allowlist extension for bounded setters (code change in `allowlist.ts`):** a new entry kind
  `setter`, e.g. `number.front_yard_sprinkler_irrigation_duration` with `set_value` and
  `value` in `{min: 5, max: 30}`, plus `cleanup_via: valve.front_yard_sprinkler_valve`. Load
  rejects a setter whose `cleanup_via` entity is missing or lacks `close_valve`. `set_value`
  stays an escalation command (all guards apply); it is never a safety command. Cleanup and
  boot sweep act on the linked valve.
- **pi_audio adapter (own contract, since it has no HA state or context):**
  - Launch: `ssh rpi-claw qp-play <intent_id> <dispatch_epoch_ms> <clip>`. `qp-play` is a
    short script on the Pi (no daemon, no port). Everything below runs while holding
    `flock ~/.local/state/quiet-porch/audio.lock`: refuse if `audio-stop-epoch` >=
    `dispatch_epoch_ms`; set the sink volume to at most the cap; `systemd-run --user
    --unit=qp-audio-<intent_id> -p RuntimeMaxSec=8 pw-play <clip>`; release the lock and
    return. The ack (unit started) comes back within the 3 s deadline; playback runs on. Both
    epochs come from ProBook's clock, so Pi clock skew cannot reorder them.
  - Command identity is the unit name. `RuntimeMaxSec=8` ends any clip on the Pi itself even
    if SSH or ProBook dies.
  - Stop (safety): `ssh rpi-claw qp-stop <stop_epoch_ms>`, under the same lock: write
    `audio-stop-epoch`, `systemctl --user stop 'qp-audio-*'`, read back that no `qp-audio-*`
    unit is active, release. A launch that passed its check holds the lock until its unit
    exists, so Stop either sees and stops that unit or runs first and the launch is refused.
  - Reconcile for `pi_audio.porch_speaker`: periodic check every 30 s lists active
    `qp-audio-*` units and stops them; an SSH failure keeps the row open and the entity
    inhibited. It is registered in the
  allowlist as `pi_audio.porch_speaker` (exterior, zones `front_yard`), with an enum of pinned
  clips (bark 5 s, wildlife clip), so it passes the same `checkAction` gate and intent log. No
  new daemon or port on the Pi.
- **Owner notification:** Telegram (chat to be chosen) with the frame and a signed,
  incident-scoped Stop link `GET /ring/stop?i=<incident>&sig=<hmac>`, expiring after 15 min,
  served by the existing service. Stop runs safety commands only. The same link works at every
  level and for both profiles.

### 9. Safety invariants (in code and tested)

- Never unlock doors or open covers (domain rejected in code; `alarm_control_panel` too).
- Allowlist by service, entity and parameter bounds; irrigation duration `{min: 5, max: 30}`.
- Interior silence: interior media players (Echo, TV, receiver) take no audio service.
- A frame with `person_present: true` can never produce a wildlife action.
- The valve never opens unless a duration of at most 30 was read back first.
- One active incident globally; entities with open reconcile rows cannot be escalated; kill
  switch; every decision logged with its frame and timestamps.

### 10. status-mcp (Alexa+ track)

MCP server (spec 2025-11-25, Streamable HTTP), tailnet/LAN only, bearer token required. Tools:
`get_incident_status`, `list_recent_incidents` (read token), `stand_down`, `set_mode` (owner
token). Calm response style. Demo through the simulated Alexa+ web app, and a real Echo if its
gate passes.

## Gates (must pass before the live runs)

| Gate                                                        | Status                                  | Substitute if it fails                      |
| ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------- |
| Event frame ready within 5 s                                | 1 sample: 1.94 s                        | none; required                              |
| Follow-up frames every 5 s during an event (source A or B)  | open                                    | ladder capped at L1                         |
| Armadillo produces a webhook                                | open: Other Motion alerts on Ring Cam 1 | fixture demo, said so (goal card kill rule) |
| Bedrock on night IR frames (person and animal)              | open                                    | none for AWS Builder                        |
| Tuya relinked, valves/lights/patio socket available         | open: Tuya user code                    | smart plug + lamp for L2                    |
| Valve closes on its own at 30 s with HA stopped | open: attended | none for the wildlife deliverable: failure stops the build and goes to Matthew for a goal revision; L4 alone may be cut |
| Valve covers Ring Cam 1's view                              | assumed                                 | map wildlife profile to the valve that does |
| Outdoor speaker plays one finite clip and stops             | passed with a tone                      | none needed                                 |
| HA user `quiet-porch` and owner user ids recorded           | open                                    | none; required for reconcile                |
| Covering sensors per zone (1b3a, 4c16 placement, batteries) | open                                    | Ring-only zones                             |
| Telegram chat chosen, Stop link end to end                  | open                                    | none                                        |
| Real Echo calling the MCP server                            | open                                    | simulated Alexa+ web app                    |

If a required gate fails, stop and revise this plan before building past it.

## Build steps

1. **Probe readout** (10-08): summarize `frame-probe.jsonl` in `recon.md`. Add a follow-up-frame
   probe (source A) to the same module.
2. **Perception + critique + evidence, dry run** (10-08 to 10-10): webhook -> events -> frame ->
   Bedrock -> profile selection -> decision log, no actuator code. Fixtures: at least 12
   labeled sequences (v6 set: family arrival, pet, delivery drop-off, sprinkler spray, uncertain
   low light, staged loiterer, loiterers leaving at 15 s and 30 s, 12 s gap; plus armadillo
   night IR, armadillo day, opossum, person and armadillo in one frame).
3. **Coordinator + adapters, dry run first** (10-10 to 10-13): both profiles, HA REST adapter,
   pi_audio adapter, Telegram, Stop route, boot sweep, reconcile. Tests below.
4. **status-mcp + simulated Alexa+** (10-13 to 10-14).
5. **Hardware gates** (as soon as Tuya is back): valve self-cutoff with HA stopped, lights,
   patio socket, speaker clips, Stop link. Hardware failure tests: HA restart, HA-to-device
   disconnect, and coordinator kill during L3/L4 and during a wildlife run; pass = clip ends and
   valve closes on its own.
6. **Trust ladder:** night 1 dry run (Telegram says "would have fired"), then attended live runs
   (staged loiterer, armadillo nights), then unattended. Each rung needs Matthew's go.
7. **Submission** (by 10-20): demo video, decision log, architecture diagram, AWS Builder
   write-up, Devpost for Ring, Alexa+ and AWS Builder.

## Tests

- **From v6 (kept):** ladder order and dwell timing; benign equals zero actions; stale frames do
  not advance; interior audio deny; lock/cover rejection; concurrent events create one incident;
  duplicate webhook ignored; restart closes incidents and sweeps actuators off; late model
  result after stand-down dropped; stand-down during every dwell and action phase; paused
  in-flight race; in-flight call that never returns (cleanup starts within 4 s, ends within
  15 s, reconcile row created); late "on" after cleanup reversed by the watcher; app user id
  never clears its own row; owner "on" clears it; crash before and after dispatch with a late
  "on"; transient off failure recovered by the periodic check; delayed critique of an older
  frame discarded; mismatched `evidence_id` or model timestamp rejected; zone B cannot inherit
  zone A's level; HA reconnect with an open row; safety commands succeed with stale or missing
  evidence and during disagreement; 12 s gap resets dwell; Ring token expiry mid-incident holds
  then exits with a sweep.
- **From review round 2:** armadillo 0.95 with critique `benign` (known pet list) gives zero
  intents; critique `nuisance` reaches wildlife; null-context row stays open past any time
  window and across restart, and a `turn_on` landing 10 min later is reversed; qp-play paused
  after its epoch check while qp-stop runs: qp-stop blocks until the launch releases the lock,
  then returns with no active audio unit and nothing plays afterward (a brief start before
  Stop takes the lock is allowed); stop-first then launch: launch refused;
  launch with a `dispatch_epoch_ms` older than the stop epoch is refused.
- **New for v7, from review round 1:**
  - Uncertainty: a 0.65 person with `unknown` and a critique `uncertain` each give zero
    actuator calls and no notification; 0.80 `unknown` reaches L1.
  - Contradictory perception (`person_present` false with person 0.95 and armadillo 0.90;
    `person_present` true with no person subject) is malformed: zero intents.
  - Event frame: a fresh `snapshot`, a recording 1500 ms from the event, a future timestamp,
    and a missing `X-Media-Timestamp` are each rejected; 611 ms recording accepted.
  - Allowlist: setter without `cleanup_via`, or pointing at an entity without `close_valve`,
    fails to load; `set_value` 31 rejected; `set_value` classified escalation.
  - Correlation: HA call timeout gives an `unknown` intent and a null-context reconcile row; a
    later `quiet-porch` state change on that entity is reversed; restart with such a row keeps
    the entity inhibited; adapter tests run against a fake HA WebSocket server, not synthetic
    ids.
  - pi_audio: launch ack within 3 s while a 5 s clip plays on; delayed launch after a stop is
    refused by the stop epoch; SSH loss mid-clip ends by `RuntimeMaxSec`; stop read-back
    finds no active unit; volume above the cap is clamped (hardware test with the real clips).
  - Preemption: same-zone person during watering cancels wildlife and opens the intruder
    incident in one transaction; wildlife cooldown does not block it; cleanup failure leaves
    reconcile rows and the ladder continues; a cross-zone person while watering; two
    concurrent intruder events during a wildlife run give one intruder incident.
- **New for v7:** Ring `sub_type` does not skip perception; wildlife profile never fires with
  `person_present: true`; confidence 0.79 vs 0.80; outside 20:00 to 06:30 logs only; irrigation
  read-back mismatch blocks `open_valve`; +40 s read-back open creates a reconcile row; intruder
  event during a wildlife run cancels it first; follow-up frame with origin `snapshot` or a
  timestamp more than 5 s off is rejected; Stop link bad signature, expired, replayed;
  pi_audio clip not in the enum rejected; status-mcp unauthenticated and read-token
  `stand_down`/`set_mode` rejected.

## Evaluation

- Fixtures: benign sequences give zero actions; staged loiterer reaches the highest gated-in
  level on schedule; loiterer leaving at 15 s exits before L2; at 30 s reaches L2 and exits
  before L3; gap resets dwell; uncertain sequences (person confidence 0.6 to 0.79, or critique `uncertain`) fire no actuator
  and send no notification; disagreeing sequences fire no actuator and send exactly one owner
  notification; armadillo
  frames fire the wildlife profile and every non-wildlife frame does not.
- Latency: webhook to first action under 10 s p50 across at least 5 live runs.

## Demo video (under 3 min)

Benign events first (zero actions in the decision log), then a staged loiterer at night through
every gated-in level with the interior silent and the stand-down visible, then the armadillo
night run (or recorded fixtures, labeled as such), then "is everything okay?" through Alexa+.
Clip audio muted or replaced in the public video.

## Done condition

All true: repo calls the Ring API and runs the MCP server in code; test suite green including
every safety and concurrency test above; fixture evaluation meets every line; a recorded live
run shows the intruder ladder through the highest gated-in level with a successful stand-down,
and an armadillo night run (or the goal card's fixture fallback, labeled) showing the valve
opening and closing on its own within 30 s; hardware failure tests pass; latency target met;
demo video public and under 3:00; Devpost shows Submitted for Ring, Alexa+ and AWS Builder (if
the Bedrock gate holds) before 2026-10-23 12:00 PT.

## Open questions for Matthew

1. Turn on Other Motion Smart Alerts on Ring Cam 1; check its zones and schedule.
2. Tuya user code to relink valves, lights and patio sockets.
3. Does the front-yard valve cover Ring Cam 1's view? Which exterior light faces each zone?
4. Which interior lights for L1 and the wildlife run?
5. Telegram: the Attention group or a separate chat?
6. Where are motion sensors 1b3a and 4c16, and will 4c16 get a battery?
7. A wildlife clip and a bark clip he owns or synthesizes; mute the clip in the public video.
8. Devpost registration status and AWS credits before 10-21.
