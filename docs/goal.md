---
id: Q-20261007-0001
title: Quiet Porch: AI-confirmed armadillo triggers a 30 s sprinkler run
status: todo
owner: Matthew
sink: Devpost submission (Ring + Alexa+ tracks, AWS Builder if Bedrock holds) and ~/projects/quiet-porch/docs/
kill: internal target 2026-10-20; hard stop 2026-10-23 12:00 PT. If no armadillo event is captured by 2026-10-15, demo on recorded fixtures and say so.
shape: one-shot
depends_on: []
attempts: 0
created: 2026-10-07
source: direct (Matthew, 2026-10-07 session)
---

## Goal

Add a nuisance-wildlife profile to Quiet Porch, with the armadillo as its test scenario, while
keeping the plan v6 intruder ladder (see plan v7). When a Ring motion event fires at night,
pull the frame from the moment of the event, have Bedrock confirm an armadillo, and only then
open the sprinkler valve that covers that camera's view for at most 30 s, turn on chosen
interior lights, play a short Rick Roll clip on a Bluetooth speaker paired to the Pi and placed
outside, and send Matthew a Telegram message with the frame and a Stop link. Benign events
(family, cars, deliveries, pets) and anything uncertain cause zero actions and are only logged; a
person never triggers the wildlife profile, only the intruder ladder. The 30 s limit is
enforced by the valve's own duration setting, so the valve closes even if Home Assistant or
Quiet Porch dies. Deliver it as a Devpost entry for the Amazon Developer Hackathon.

## Done when

A recorded night run shows a real Ring event of the armadillo producing a logged Bedrock
"armadillo" verdict, the valve opening and closing on its own within 30 s (HA history), the
clip playing, interior lights on, and a Telegram message with a working Stop link; the decision
log over the same period shows zero actions on every benign event (family, deliveries,
vehicles, pets), and the plan v7 intruder ladder is demonstrated on a staged loiterer; and Devpost
shows the entry as Submitted before 2026-10-23 12:00 PT.

## Action

Read Ring Cam 1's night events after Matthew enables Other Motion alerts, and pull the first
armadillo frame for a Bedrock recognition test.

## Why this shape

One sequential build with hardware gates in between (Ring alert setting, Tuya relink, valve
cutoff test, speaker pairing), so one-shot. The finished service runs continuously, but going
live at night unattended is a trust-ladder step: first night detect-and-notify only (dry run),
then attended live runs, then unattended.

## Decisions (Matthew, 2026-10-07)

- ~~Armadillo only. The human-intruder escalation from plan v6 is dropped; humans never trigger
  an actuator.~~ Superseded the same day by Matthew: "We shouldn't be removing the original
  functionality of what this system was designed to do. The armadillo is just a test scenario,
  not the only thing it can do." The v6 intruder ladder stays; the armadillo is the test
  scenario for a new wildlife profile (plan v7).
- Speaker plays a Rick Roll clip outdoors (armadillos are unlikely to care about sound; it is
  for the demo).
- Sprinkler run capped at 30 s.
- Telegram with a Stop control.

## Verified state this goal starts from (2026-10-07)

- Ring linking, signed webhooks and token refresh work (65 motion events, 0 rejected).
- Event-time frames download in about 0.9 s (`at_timestamp`). Bedrock vision works on a day frame.
- HA has `valve.front_yard_sprinkler_valve` and `valve.backyard_sprinkler_valve`, each with a
  `number.*_irrigation_duration` entity. Both valves and all 15 HA lights are `unavailable`
  (Tuya link broken).
- Pi Bluetooth controller is powered; the HA container is privileged with `/run/dbus` mounted.

## Risks

- **No armadillo events.** Ring Cam 1 has Smart Alerts on and sent only `human` (43 of 43).
  Ring labels unclassified motion `other_motion`; if that alert type is off, an armadillo never
  produces a webhook. No events arrived 01:00 to 07:00 on 10-07.
- **Night recognition.** Bedrock has only been tested on a daylight frame; the armadillo will be
  in infrared, grayscale and small in frame.
- **Valve cutoff.** Unverified that the irrigation duration is enforced on the device rather than
  by Tuya cloud or HA.
- **Recording readiness.** Unverified that the event-time frame is downloadable within a few
  seconds of the webhook.
- **Music rights.** A Rick Roll in the public demo video is third-party copyrighted audio.
