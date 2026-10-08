# Ring integration recon

Facts verified against live Ring traffic on 2026-10-06, from the `quiet-porch.service` journal,
`~/.local/state/quiet-porch/`, and a read-only `GET /v1/devices`. Anything not marked verified is
open. Replaces the lost `recon-facts.md`.

## Linking is started from the Ring AppStore, not the console

Clicking **Connect Ring account** in the developer console only authorizes a Ring account to see
the private app (console then shows "Connect (1 out of 10)"). It sends nothing to our endpoints:
the journal stayed empty from 10-05 21:23 until the AppStore step below.

The flow that actually ran (CDT, 2026-10-06):

```
Ring mobile app: Ring AppStore -> Quiet Porch -> approve scopes
        |
        v
16:28:42  Ring backend POST /ring/token-exchange   fields=[code,client_id]
16:28:43  we exchange the code, store UNCLAIMED tokens (scope=ava.v1:read)
        |
        v  (user picks devices in the Ring app)
16:29:22  browser GET /ring/link                    params=[nonce,time]
16:30:53  wrong password (1/5)
16:31:36  webhook app_integration_added
16:31:37  webhook device_added x2
16:31:37  link: COMPLETED, devices=2
```

Order matches Ring's api-documentation.html: token exchange is backend-to-backend and arrives
before the user is redirected to the Account Link URL.

## Token exchange

- **Verified:** Ring POSTs exactly two fields, `code` and `client_id`. `extractCode` in
  `src/server.ts` also accepts `authorization_code` and `auth_code`; those fallbacks were never
  needed.
- **Verified:** the code exchange at `https://oauth.ring.com/oauth/token` succeeds with
  `grant_type=authorization_code`.
- **Verified:** granted scope is `ava.v1:read` (read-only).
- **Verified:** access token lifetime is 14400 s (4 h), from `expires_at - issued_at` in
  `tokens.json`.
- **Verified:** the refresh loop renewed real tokens at 2026-10-06 19:29:12 CDT (75% of the
  4 h lifetime). New tokens: issued 19:29:12, expire 23:29:12, status still `completed`. This is
  a natural renewal, not the plan's forced-expiry test.
- **Open:** request content type (JSON vs form). `parseFields` handles both and does not log which.

## Account link nonce

- **Verified:** Ring appends `nonce` and `time` (no other params) to the Account Link URL.
- **Verified:** the nonce check in `src/crypto.ts`
  (`base64url(HMAC-SHA256(RING_HMAC_KEY, "<time>:<account_id>"))`) matched the real account,
  since the link reached `COMPLETED`.

## Webhooks

- **Verified:** real Ring webhooks pass `verifyWebhookSignature`
  (`hex(HMAC-SHA256(RING_HMAC_KEY, raw body))`). The code accepts the header with or without a
  `sha256=` prefix; which form Ring sends is not logged.
- **Verified event types seen:** `app_integration_added` (`source_type: users`) and
  `device_added` (`source_type: devices`, one per shared device, with a
  `relationships.devices.links.self` path of `/v1/devices/<id>`).

## Linked account and devices

Account: `ava1.ring.account.REDACTED`

`GET https://api.amazonvision.com/v1/devices` returned:

| Name       | Device ID                                                                                                           | Role        |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ----------- |
| Front Door | `ava1.ring.device.FRONT_DOOR` | doorbell    |
| Ring Cam 1 | `ava1.ring.device.RING_CAM_1` | outdoor cam |

`listDevices` in `src/ring.ts` keeps only `id` and `attributes.name`, so other device attributes
(model, kind) were not inspected. Roles confirmed by Matthew on 2026-10-06.

## Gate checks run 2026-10-06 16:50 CDT

### Stored image download (step 1c "frame timestamp provenance")

`POST /v1/devices/{id}/media/image/download` with `type: latest_in_range`, then GET the 303
`Location`. Requests ran 16:50:29 to 16:50:43.

- **Verified:** a 24 h window is refused at step 1 with
  `403 TIME_RANGE_NOT_AUTHORIZED` ("Requested time range is not within authorized boundaries").
  This code is not in api-documentation.html. A window starting 16:31:35 is accepted, so access
  appears to start around link time; the exact boundary was not bisected.
- **Verified:** Ring Cam 1 returned `200 image/jpeg`, 60021 bytes, 640x360, in about 620 ms
  end to end, with `X-Media-Timestamp: 1791322351595` (16:32:31 CDT) and
  `X-Media-Origin: snapshot`. The frame was 1091 s old, so a stored snapshot is not a live
  frame; the 5 s freshness rule will reject this kind of result.
- **Verified:** Front Door returned `416 MEDIA_NOT_FOUND` for the window since link: no media
  recorded there yet.
- Every image carries a Ring watermark (device ID suffix, "Partner: Quiet Porch", generation
  time).

### Bedrock vision (step 1c "Bedrock vision")

- **Verified:** Converse API with bearer auth (`AWS_BEARER_TOKEN_BEDROCK`), region `us-east-1`,
  model `global.anthropic.claude-sonnet-4-6`, on the Ring Cam 1 frame: `200` in 2428 ms,
  378 input and 69 output tokens.
- **Verified:** output was the requested perception JSON with a matching `evidence_id`
  (`person_present: false`, `confidence: 0.93`), but wrapped in a json code fence despite
  "ONLY a JSON object". The client must strip fences before parsing.

### Still open in the step 1c gate

Live-stream frame (WHEP/RTSPS), forced-expiry refresh test, HA `quiet-porch` user, exterior
actuators.

### Signed motion webhooks (step 1c, first half)

**Verified:** 6 signed `motion_detected` webhooks on `/ring/webhook` between 18:05 and 18:57 CDT
on 2026-10-06, 0 rejected. Attributes are exactly `source`, `source_type`, `timestamp`,
`sub_type`. Front Door sent `sub_type: motion` once; Ring Cam 1 sent `sub_type: human` five
times. No frame was pulled for these events.

## First day of motion events, checked 2026-10-07 13:33 CDT

- **Verified:** 65 signed `motion_detected` webhooks from the link to 13:17 on 10-07, 0 rejected,
  0 service restarts. Front Door sent 22 (`sub_type: motion` every time); Ring Cam 1 sent 43
  (`sub_type: human` every time). Busiest hour 11:00 to 12:00 CDT with 14.
- **Verified:** delivery lag from `attributes.timestamp` to our receipt, n=65: min 708 ms,
  p50 1079 ms, p90 1335 ms, max 30720 ms.
- **Verified:** `at_timestamp` set to the event's `attributes.timestamp` returns a frame from the
  event itself: `X-Media-Origin: recording`, frame 0 ms (Ring Cam 1, 1920x1080) and 611 ms
  (Front Door, 1280x720) after the event, about 0.9 s per download. Pulled hours after the
  events, not live.
- **Verified:** `latest_in_range` over the 30 s after an event returned frames 10.8 s and 29.9 s
  after the event, so it picks the end of the window, not the event.
- The 10-06 `416` on Front Door and the 1091 s old snapshot came from before any recordings
  existed; they do not mean stored frames are stale.
- **Open:** whether `at_timestamp` works within the ~2 s after a webhook, or returns
  `425 RECORDING_NOT_READY` until the clip is processed. This decides whether stored frames can
  meet the plan's 5 s freshness rule.

## Service state

- `quiet-porch.service` (systemd --user) enabled at boot on 2026-10-06; linger is on.
- Funnel `/ring` proxies to `http://127.0.0.1:3460` and is stored in tailscaled's serve config.

## Outdoor speaker on rpi-claw, verified 2026-10-07 15:10 CDT

- Anker SoundCore `08:EB:ED:87:2E:8F` is bonded (LinkKey stored) and is the default PipeWire
  sink `bluez_output.08:EB:ED:87:2E:8F`. A 440 Hz tone played and was heard (Matthew).
- The first pairing was made with the adapter `Pairable: no`, so BlueZ kept no key and a reboot
  forgot the device. Re-paired with `pairable on`; the bond now survives reboots.
- The GDM greeter's own WirePlumber held the BlueZ endpoints, so rpi-claw's stack got
  `RegisterProfile() failed: NotPermitted` and only a Dummy Output. Fix: Pi boots to
  `multi-user.target` (undo: `sudo systemctl set-default graphical.target`).
- rpi-claw user changes: linger on, `~/.config/wireplumber/wireplumber.conf.d/80-headless-bluez.conf`
  (`monitor.bluez.seat-monitoring = disabled`).
- Neither the Pi nor the speaker initiates a reconnect after a reboot or a speaker power-cycle.
  `anker-reconnect.service` (systemd --user, `~/.local/bin/anker-reconnect.sh`) runs
  `bluetoothctl connect` every 15 s while disconnected. Reboot plus power-cycle test: reconnected
  about 2 min after boot, default sink restored, tone played.
- Sink volume is 0.69. A `wpctl set-volume` on node 59 hit the internal node, not the sink.
- **Open:** Home Assistant cannot play to this speaker yet; playback today is `pw-play` on the Pi.

## HA inventory, read 2026-10-07 15:19 to 15:25 CDT (REST /api/states, /api/config)

- HA 2026.9.4; `mcp_server` loaded: False; tuya loaded: True; alexa_devices loaded: True.
- 231 entities. Re-read at 15:33 CDT for this record.
- `binary_sensor.bedroom_echo_spot_motion`: off
- `binary_sensor.front_room_motion`: unavailable
- `binary_sensor.living_room_echo_spot_motion`: off
- `binary_sensor.motion_sensor`: unavailable
- `binary_sensor.motion_sensor_1b3a_light`: off
- `binary_sensor.motion_sensor_1b3a_motion`: off
- `binary_sensor.motion_sensor_4c16_light`: on
- `binary_sensor.motion_sensor_4c16_motion`: off
- `light.backdoor_light`: unavailable
- `light.bathroom_1`: unavailable
- `light.bathroom_2`: unavailable
- `light.bright_light`: unavailable
- `light.bright_light_2`: unavailable
- `light.bright_light_3`: unavailable
- `light.color_lights`: unavailable
- `light.color_lights_2`: unavailable
- `light.headboard`: unavailable
- `light.stairs`: unavailable
- `light.worklight_1`: unavailable
- `light.worklight_2`: unavailable
- `light.worklight_3`: unavailable
- `light.worklight_4`: unavailable
- `media_player.65_qled`: off
- `media_player.bedroom_echo_spot`: idle
- `media_player.everywhere`: idle
- `media_player.front_room`: unavailable
- `media_player.living_room_echo_spot`: idle
- `media_player.main_room_echo`: unavailable
- `media_player.matthew_s_echo_show_8_3rd_gen`: idle
- `media_player.onkyo_tx_nr676_ea3ccf`: off
- `media_player.shield`: off
- `media_player.surround_1`: unavailable
- `number.backyard_sprinkler_irrigation_duration`: unavailable
- `number.front_yard_sprinkler_irrigation_duration`: unavailable
- `sensor.motion_sensor_1b3a_battery`: 20
- `sensor.motion_sensor_4c16_battery`: 0
- `sensor.motion_sensor_battery_sensor`: unavailable
- `switch.back_patio_socket_1`: unavailable
- `switch.back_patio_socket_2`: unavailable
- `switch.patio_light_socket_1`: unavailable
- `valve.backyard_sprinkler_valve`: unavailable
- `valve.front_yard_sprinkler_valve`: unavailable

## Fixture evaluation set1, 2026-10-07 15:53 CDT (plan v7 step 2)

`node scripts/eval-fixtures.ts` over 19 labeled single frames in
`~/.local/state/quiet-porch/fixtures/set1` (outside the repo): 7 armadillo (Wikimedia Commons,
2 synthetic-IR, 1 real night flash, 2 small/far), 5 other animals (opossum incl. synthetic IR,
raccoon, deer, dog), 5 real Ring frames from our cameras, 2 synthetic-IR person frames in
mode `away`. Real Bedrock, the live `judgeFrame` path.

- **18/19 as labeled.** Every armadillo frame reached `wildlife` (confidence 0.93 to 0.99,
  verdict `nuisance`), including both synthetic-IR ones; the daytime one was logged
  (`outside_night_window`). Every other animal was `nothing_actionable`. Both `away` person
  frames reached `intruder`.
- **One false alarm:** `ring-door-person` (real Front Door frame, daytime, mode `home`, person
  on the porch facing away) got critique `unknown` and would have opened an intruder incident
  at L1. The label assumed a household member; the system cannot know that.
- `ring-door-empty` saw a "small figure" at 0.72 and was logged as `person_uncertain`.
- Not covered yet: a real night IR armadillo from our camera, real night people, multi-frame
  dwell sequences (step 3).

## 2026-10-07 evening: live dry run, other_motion timing, step 3 status

### other_motion timing (gate: "Event frame ready within 5 s")

- Ring Cam 1 (`front_yard`) sent its first `other_motion` webhooks today (21:06Z and 21:32Z),
  so Other Motion alerts appear to be on. `grep -o '"sub_type":"[a-z_]*"'
  webhook-events.jsonl | sort | uniq -c` at 21:33Z: human 48, motion 25, other_motion 2.
- Both arrived late: `received_after_event_ms` 10724 and 11211. Ring classifies before it
  sends.
- The recording was not downloadable until 10 to 15 s after receipt (follow-up probe: 416 at
  +5 s and +10 s, 200 recording at +15 s), so about 21 to 26 s after the event.
- `human` and `motion` are fast: frames ready 1.8 s to 6.3 s after the event, decisions at 8 to
  12 s (21:07Z and 21:38Z).
- Consequence: the event-frame retries now run to +20 s after receipt (`5405cdb`), so an
  other_motion frame is fetched and judged. But the 15 s evidence-age rule then rejects any
  intruder or wildlife decision on it as `stale_evidence`. **As built, the wildlife profile cannot
  fire on an other_motion event.**
- Resolved 10-07. Matthew said a person and an armadillo at the same time is unlikely (a
  person would scare it off) and that 45 s is too long. Wildlife trigger frames may now be up to
  `wildlifeMaxEvidenceAgeMs` = 35 s old (config; code allows 15 to 40 s). The run's steps then
  have a 10 s dispatch budget. The intruder ladder stays at 15 s. 35 s is about the floor:
  readiness is ~26 s, plus ~6 s for two Bedrock calls.

### Step 3 (coordinator + adapters, dry run): built 10-07

Built and tested:
- Schema v3 (`e402ee9`).
- Ladder and action plans (`ladder.ts`).
- Coordinator (`coordinator.ts`): guards, write-ahead intents, cleanup, reconcile, boot sweep,
  preemption, and cooldowns.
- Adapters (`actuators.ts`): a dry-run simulator plus HA REST, pi_audio and Telegram.
- Signed single-use Stop route, and the Pi scripts (`scripts/pi/qp-*`).

Live state: deployed (`aac2eb5`) in dry run, max intruder level 1, and no interior lights
configured. Every actuator call is a `would_call` in `coordinator.jsonl`. 159 tests pass. A
mutation sweep over the 8 escalation and cleanup guards fails at least one test for each.

Not built yet (each one is named in plan v7):
- HA WebSocket `state_changed` watcher for late-command attribution. Null-context reconcile rows
  get only the periodic off and read-back, and only an owner can clear them.
- The sensor disagreement rule. Covering sensors are unconfirmed, so all zones are Ring-only.
- The follow-up frame loop during an incident. The ladder only sees webhook frames, which is why
  it is capped at L1.
- An owner-clear route for reconcile rows. The function exists; status-mcp (step 4) will expose
  it.
- The race test where qp-play is paused after its epoch check while qp-stop runs. Only the
  stop-first and older-epoch cases are tested.
- `qp-*` and the clips are not installed on the Pi; that waits for the hardware gate.

### Step 4 (status-mcp + simulated Alexa+): built 10-07

- `src/mcp.ts` is a tools-only MCP server: Streamable HTTP, protocol 2025-11-25, single JSON
  responses. It listens on `0.0.0.0:3461/mcp` (LAN and tailnet); the Funnel does not route to
  it.
  - Read token: `get_incident_status` and `list_recent_incidents`.
  - Owner token: also `stand_down`, `set_mode` and `clear_reconcile`.
  - Tokens are in `~/.local/state/quiet-porch/mcp-tokens.json` (mode 600).
- `set_mode` writes a persisted live mode (`mode.json`). Both the pipeline (critique context and
  the daytime-home rule) and the coordinator (L4 eligibility) read it.
- The simulated Alexa+ page is at `http://10.0.0.46:3461/alexa`. The viewer pastes a token, and
  replies are spoken.
- Verified 10-07 23:04 against the live service with curl: initialize, status, and 401 without a
  token.
- Verified 23:07 in a browser against a throwaway instance with demo tokens, which keeps the real
  token out of the transcript: status, stand down, good night (set_mode night), recent.
- Not verified: a real Echo calling the server. That gate is still open.
