# Plan v7: Quiet Porch armadillo deterrent

Supersedes plan v6 (`~/.claude/checkmate/runs/2026-09-27-1021-ai-home-deterrent-v5/plan-v2.md`).
Goal card: `docs/goal.md` (Q-20261007-0001). Written 2026-10-07 15:20 CDT.

## Goal

A Ring motion event at night is checked by Bedrock on the frame from the event's own moment. Only
a confirmed armadillo opens the sprinkler valve covering that camera for at most 30 s, turns on
chosen interior lights, plays a short clip on the outdoor speaker, and sends Matthew a Telegram
message with the frame and a Stop link. Everything else (people, vehicles, deliveries, pets,
uncertain frames) is logged and causes zero actions. Shipped as a Devpost entry by
2026-10-20 (hard stop 2026-10-23 12:00 PT).

## What changed from v6

v6 was a person-intruder escalation ladder. Matthew's 2026-10-07 decisions make it armadillo
only, so these v6 parts are dropped:

- the L0 to L4 ladder, dwell timing, and the 20/40/60 s escalation;
- the separate critique agent, the Strands action picker, and the context store;
- secondary-sensor disagreement (Wyze, Aqara);
- the TV, the spotlight, and the dog bark;
- live-stream (WHEP/RTSPS) frames: event-time stored frames are now proven (below).

Kept from v6: signed webhooks, evidence binding, the allowlist, the write-ahead action log, the
valve's own duration limit, and the trust-ladder rollout.

## Verified facts (this session or `docs/recon.md`)

- Signed `motion_detected` webhooks: 72+ received, 0 rejected. Payload attributes are exactly
  `source`, `source_type`, `timestamp`, `sub_type`. Ring Cam 1 sent only `human`; Front Door
  only `motion` (Smart Alerts off there).
- `at_timestamp` at the event time returns the event's own frame (`X-Media-Origin: recording`).
  First live probe (2026-10-07 15:17, Ring Cam 1): `200` on the first request, frame 0 ms from
  the event, usable 1.94 s after the event. One sample; the probe keeps logging to
  `frame-probe.jsonl`.
- Bedrock Converse (`global.anthropic.claude-sonnet-4-6`, bearer auth) reads a day frame in
  about 2.4 s and returns JSON inside a code fence; `parseModelJson` handles that.
- HA at `HASS_URL` answers with `HASS_TOKEN` (231 entities). `valve.front_yard_sprinkler_valve`,
  `valve.backyard_sprinkler_valve` and their `number.*_irrigation_duration` (0 to 86400 s) exist
  but are `unavailable`, as are all 15 lights and most sockets (Tuya link broken). HA has no
  media player for the Anker speaker.
- Anker speaker on rpi-claw: bonded, default PipeWire sink, auto-reconnects
  (`anker-reconnect.service`), `pw-play` works over SSH from ProBook.
- Telegram bot tokens and chat ids exist in `~/.env.shared` (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_ATTENTION_CHAT_ID`, others). Which one to use is Matthew's call.
- Repo: `src/allowlist.ts`, `src/bedrock.ts`, `src/db.ts` scaffold with 54 passing tests.

## Pipeline

```
Ring webhook (signed)
  -> events table (unique source_event_id)
  -> triage gate:  sub_type human | vehicle | package_delivery  -> log, stop
                   outside night window, kill switch on          -> log, stop
  -> frame:        at_timestamp(event ts), retry +2 s, +5 s on 425; evidence row
  -> perception:   Bedrock, strict JSON, evidence_id must match
  -> decision:     armadillo AND confidence >= 0.80 AND no person
                   AND zone not in cooldown AND valve has no open reconcile row
                   AND evidence captured < 15 s ago
                   else log, stop
  -> actions:      each through checkAction(), write-ahead intent first
                   1. set number.<zone>_irrigation_duration = 30, read it back
                   2. valve.open_valve
                   3. interior lights on
                   4. play the pinned clip on the porch speaker
                   5. Telegram: frame + verdict + Stop link
  -> follow-up:    at +40 s read the valve back closed, else alert + reconcile row
```

### 1. Triage (deterministic, no model call)

- Device to zone map in config: Ring Cam 1 -> `front_yard` (valve coverage assumed, Matthew to
  confirm). Front Door has no valve; its events are logged only.
- `human`, `vehicle`, `package_delivery` never reach Bedrock or an actuator. `other_motion` and
  `motion` go on. This is the first of two guards for "humans never trigger an actuator"; the
  model's `person_present` is the second.
- Night window from config (default 20:00 to 06:30 local). Kill switch: a file flag plus an env
  var, checked on every event.

### 2. Frame and evidence

- Reuse `downloadImageAt` from the probe. Keep the JPEG in memory. Write it to disk only for
  events that reach the decision step, for the Telegram message and the demo.
- Evidence row: `evidence_id` = sha256 of (device, capture ts, image hash), capture time from
  `X-Media-Timestamp`, never from the model.
- Optional second frame at event +1.5 s if the probe data shows small subjects are missed. Not
  in the first build.

### 3. Perception (Bedrock)

Prompt asks for JSON only:
`{evidence_id, subject: armadillo|cat|dog|opossum|raccoon|person|vehicle|other|none,
confidence, person_present, night_ir, reason}`. Schema-validated. A mismatched `evidence_id`,
bad JSON, a timeout or an HTTP error each mean no action.

### 4. Decision (deterministic)

Fires only if every gate in the pipeline box passes. Cooldown: 10 min per zone, persisted in
the existing `cooldowns` table. The `incidents` table is reused with level 0 = logged and
level 1 = fired. The one-active-incident index stays.

### 5. Actions

- **Valve:** the duration must be set to 30 and read back as 30 before `open_valve` is sent.
  If the read-back fails, nothing opens. The 30 s limit is the valve's own setting, so it holds
  if HA or Quiet Porch dies. Allowlist: `number.set_value` with `value` in `{min: 5, max: 30}`,
  `valve.open_valve`, `valve.close_valve`.
- **Lights:** the interior lights Matthew picks, `turn_on` only, reverting after 5 min.
  Blocked until Tuya is relinked.
- **Speaker:** HA cannot drive it, so a small adapter runs `ssh rpi-claw pw-play <pinned file>`
  (one finite clip, no loop, Pi-side volume cap). Stop is `pkill pw-play`. It is registered in
  the allowlist as `pi_audio.porch_speaker` (exterior, zone `front_yard`), so it passes the same
  `checkAction` gate and write-ahead log as every HA call. This means adding one adapter kind
  to the allowlist; no new daemon or port on the Pi.
- **Telegram:** `sendPhoto` with the frame, verdict, confidence, and a Stop URL button.
- **Stop:** `GET /ring/stop?i=<incident>&sig=<hmac>` on the existing service and Funnel route.
  It is signed per incident and expires after 15 min. It runs safety commands only:
  `close_valve`, speaker stop, lights back. Safety commands bypass evidence guards, as in v6.

### 6. Persistence and recovery

`db.ts` as built: write-ahead `action_intents`, a `reconcile` row for any valve that does not
read back closed at +40 s, and a boot sweep that closes both valves and stops the speaker before
any event is accepted. v6's watcher and context-id machinery is cut to the valve only: a
reconcile row re-sends `close_valve` every 30 s until it reads closed or Matthew clears it.

### 7. Safety invariants (tested)

- No `human`/`vehicle`/`package_delivery` event and no `person_present: true` frame can produce
  an action intent.
- Only `valve.*`, `number.*_irrigation_duration`, the chosen lights and `pi_audio.porch_speaker`
  are in the allowlist; lock/cover/alarm stay rejected in code.
- The valve never opens unless a duration of at most 30 was read back first.
- Interior media players (Echo, TV) take no audio services (existing rule).
- Kill switch, cooldown, and the one-active-incident index hold under concurrent webhooks.

## Gates (must pass before the live run)

| Gate                                            | Status           | How                                               |
| ----------------------------------------------- | ---------------- | ------------------------------------------------- |
| Event-time frame ready within 5 s               | 1 sample: 1.94 s | probe data over a day, both cameras               |
| Armadillo produces a webhook                    | open             | Matthew enables Other Motion alerts on Ring Cam 1 |
| Bedrock recognizes a night IR animal            | open             | first real night frame, plus fixture set          |
| Tuya relinked, valves and lights available      | open             | Matthew supplies Tuya user code                   |
| Valve closes on its own at 30 s with HA stopped | open             | attended test, Matthew present                    |
| Valve covers Ring Cam 1's view                  | assumed          | Matthew confirms                                  |
| Speaker plays and stops on command              | passed (tone)    | repeat with the real clip                         |
| Telegram chat chosen, Stop link works           | open             | Matthew picks chat                                |

If the armadillo webhook or the valve self-cutoff gate fails, stop and revise this plan.

## Build steps

1. **Probe readout** (2026-10-08): summarize `frame-probe.jsonl` in `recon.md`.
2. **Triage + frame + perception, dry run** (10-08 to 10-10): webhook -> events -> triage ->
   frame -> Bedrock -> decision log. No actuator code yet. Fixtures: at least 12 labeled frames
   (armadillo day and night IR, cat, dog, opossum, person night, empty yard, sprinkler spray,
   rain, low-light uncertain). Public armadillo images are used only for the local eval, never
   in the demo.
3. **Actions behind the allowlist** (10-10 to 10-12): HA client, valve sequence with
   duration read-back, speaker adapter, Telegram, Stop route, boot sweep. All tested against a
   fake HA and a fake SSH runner.
4. **Hardware gates** (when Tuya is back): valve self-cutoff with HA stopped, lights, speaker
   with the real clip, Stop link end to end.
5. **Trust ladder:** night 1 dry run (Telegram says "would have fired"), then attended live
   nights, then unattended. Each rung needs Matthew's go.
6. **Demo and submission** (by 10-20): recorded night run, decision log showing zero actions on
   human events, architecture diagram, AWS Builder write-up, Devpost submitted.

## Tests (step 2 and 3)

- Triage: each Ring `sub_type`; night window edges; kill switch.
- Perception: fenced JSON, prose around JSON, bad schema, mismatched `evidence_id`, timeout,
  HTTP 5xx each produce zero intents.
- Decision: confidence 0.79 vs 0.80; `person_present` true with `armadillo`; stale evidence
  (16 s); cooldown; open reconcile row.
- Valve: duration read-back mismatch blocks `open_valve`; HA error mid-sequence leaves a
  reconcile row; +40 s read-back open -> alert + re-close loop.
- Stop: bad signature, expired, replayed; Stop during the sequence aborts queued steps.
- Concurrency: two webhooks for the same event (dedupe); two events 2 s apart (one incident).
- Boot: pending intent becomes a reconcile row; sweep closes valves before events are taken.

## Evaluation

- Fixture set: every non-armadillo frame gives zero intents; armadillo frames fire at an
  observed rate reported honestly, not tuned to the fixtures.
- Live: webhook to valve open under 10 s p50 across attended runs.
- Decision log over the whole live period: zero actions on `human`, `vehicle` and pet events.

## Open questions for Matthew

1. Turn on Other Motion Smart Alerts on Ring Cam 1, and check its motion zones and schedule.
2. Tuya user code to relink the valves and lights.
3. Does the front-yard valve cover Ring Cam 1's view?
4. Which interior lights?
5. Telegram: the Attention group or a separate chat?
6. A clip he owns, and agreement to mute it in the public video.
7. Night window: is 20:00 to 06:30 right?
8. Devpost tracks: v6 entered Ring + Alexa+ + AWS Builder. Alexa+ needs a voice or MCP surface
   this plan no longer has. Drop Alexa+, or add a small read-only status MCP as a stretch step
   after step 6?
