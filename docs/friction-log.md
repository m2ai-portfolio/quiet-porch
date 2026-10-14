# Friction log

Frictions met while building Quiet Porch on Ring's 2026 Partner API, Amazon Bedrock and MCP. Each
entry gives the endpoint, when it was observed, the request ID, what it cost, the workaround and a
command that reproduces the numbers. Measurements come from `docs/recon.md` and the service logs
in `~/.local/state/quiet-porch/`; nothing here is an opinion without a number behind it.

**Request IDs.** Builds before 2026-10-11 did not store them, so entries F-01 to F-12 say
`not captured` instead of guessing. From the 2026-10-11 build on, the service stores them:

| Source                             | File                   | Field                                              |
| ---------------------------------- | ---------------------- | -------------------------------------------------- |
| Ring media download (POST, step 1) | `frame-probe.jsonl`    | `attempts[].request_id`, `follow_ups[].request_id` |
| Ring media download (GET, step 2)  | `frame-probe.jsonl`    | `attempts[].media_request_id`                      |
| Ring device configuration          | `friction.jsonl`       | `request_id`                                       |
| Bedrock Converse                   | `model-calls.jsonl`    | `request_id` (`x-amzn-requestid`)                  |
| Ring webhooks                      | `webhook-events.jsonl` | `body.meta.request_id` (already stored)            |

Fill the `Request ID` cell of an entry from those files the next time it is observed. An entry
whose cell still says `not captured` is a gap in this log, not a claim.

Times: `Z` is UTC, `CDT` is America/Chicago. Dates are 2026.

## Ring Partner API

### F-01 Event frame is not ready when the webhook arrives (`416`)

- **Endpoint:** `POST /v1/devices/{id}/media/image/download` with `type: at_timestamp`, then the 303 `Location`.
- **Observed:** 10-07 20:17Z to 10-08 20:36Z, 41 events (`docs/recon.md`, "step 1 probe readout").
- **Request ID:** not captured.
- **Finding:** `human`: 14 of 20 frames on the first request, ready after the event p50 2.3 s, p90 3.6 s, max 9.8 s. `motion`: 0 of 17 on the first request, always ready on a retry at +2 s or +5 s (p50 3.5 s, p90 6.3 s, max 6.6 s). One `human` event (10-07 21:05Z) answered `416` through +5.9 s.
- **Cost:** a one-shot fetch at the webhook misses the frame; a 5 s freshness rule is met 32 of 37 times; by the readout table 36 of the 37 `human` and `motion` events got a frame (19 of 20 and 17 of 17; recon's own verdict line says 35 of 37), all within 10 s.
- **Workaround:** retry at receipt +0/2/5/8/12/16/20 s (`PROBE_OFFSETS_MS`, `src/frames.ts`); a 200 counts only if it is a `recording` within 1 s of the event and not after receipt (`checkEventFrame`).
- **Reproduce:** `node scripts/probe-readout.ts`.

### F-02 `other_motion` webhooks arrive about 11 s late and their recording is later still

- **Endpoint:** webhook `motion_detected` with `sub_type: other_motion`; media download as in F-01.
- **Observed:** 10-07 21:06Z and 21:32Z (first two), 4 events by 10-08.
- **Request ID:** not captured (webhook `meta.request_id` is in `webhook-events.jsonl`).
- **Finding:** `received_after_event_ms` 10724 and 11211; webhook delay p50 10.9 s for `other_motion` against 1.2 s for `human`. The recording was `416` at receipt +5 s and +10 s and `200` at +15 s, so about 21 to 26 s after the event. On 10-07 23:12Z every request through event +30.9 s was `416`; 1 of 4 `other_motion` events got a frame.
- **Cost:** the nuisance-wildlife trigger frame is 21 s or more old when it can first be judged.
- **Workaround:** retries run to receipt +20 s; wildlife frames may be up to 35 s old (`wildlifeMaxEvidenceAgeMs`, ceiling 40 s) while the intruder ladder keeps its 15 s rule.
- **Reproduce:** `node scripts/probe-readout.ts`; `grep -o '"sub_type":"[a-z_]*"' webhook-events.jsonl | sort | uniq -c`.

### F-03 `latest_in_range` returns the end of the window, not the event

- **Endpoint:** `POST /v1/devices/{id}/media/image/download` with `type: latest_in_range`.
- **Observed:** 10-07 13:33 CDT, over the 30 s after an event.
- **Request ID:** not captured.
- **Finding:** frames came back 10.8 s and 29.9 s after the event.
- **Cost:** "the frame of the event" is not what the name suggests.
- **Workaround:** use `at_timestamp` with the webhook's `attributes.timestamp`; the result carries `X-Media-Timestamp`, which we treat as the capture time.
- **Reproduce:** `docs/recon.md`, "First day of motion events".

### F-04 Undocumented `403 TIME_RANGE_NOT_AUTHORIZED`

- **Endpoint:** `POST /v1/devices/{id}/media/image/download`, step 1.
- **Observed:** 10-06 16:50 CDT.
- **Request ID:** not captured.
- **Finding:** a 24 h window was refused with "Requested time range is not within authorized boundaries"; a window starting 16:31:35 (the link time) was accepted. The code is not in `api-documentation.html`. The exact boundary was not bisected.
- **Cost:** history from before an account was linked cannot be read, which the docs do not say.
- **Workaround:** request windows that start at or after link time.
- **Reproduce:** `docs/recon.md`, "Gate checks run 2026-10-06".

### F-05 Recordings end 10 to 14 s after the event

- **Endpoint:** `POST /v1/devices/{id}/media/image/download`, `at_timestamp` at `now - 2 s` (follow-up probe at receipt +5/+10/+15 s).
- **Observed:** 10-07 20:17Z to 10-08 20:36Z.
- **Request ID:** not captured.
- **Finding:** `human` (camera 1): 54 of 54 `200` at event +4 s and +9 s. At event +14 s the frame returned is earlier than requested in 12 of 18 `human` and 15 of 16 `motion` events, by up to 4.1 s.
- **Cost:** stored frames give fresh evidence for the life of one clip only, under the 20 s dwell the ladder needs, so the ladder is capped at L1 on clip evidence.
- **Workaround:** live view as the freshness source was tried and recorded as a no-go (F-17), so the ladder works from clip evidence and the ledger says `source clip`.
- **Reproduce:** `node scripts/probe-readout.ts`.

### F-06 Webhook delivery lag has a long tail

- **Endpoint:** webhook `motion_detected`.
- **Observed:** from the link (10-06 16:31 CDT) to 10-07 13:17 CDT, n = 65.
- **Request ID:** webhook `meta.request_id`.
- **Finding:** from `attributes.timestamp` to receipt: min 708 ms, p50 1079 ms, p90 1335 ms, max 30720 ms.
- **Workaround:** the ledger records Ring capture time and the age of every frame, so a late webhook shows as an older frame, never as a fresher one.
- **Reproduce:** `jq -r '(.received_at | sub("\\.[0-9]+Z$";"Z") | fromdate) - (.body.data.attributes.timestamp / 1000)' webhook-events.jsonl | sort -n` (whole seconds, from the webhook log).

### F-07 Webhook gap with no explanation

- **Endpoint:** webhook delivery.
- **Observed:** no Ring webhooks from 10-08 00:00Z to 15:00Z (19:00 to 10:00 CDT).
- **Request ID:** none, nothing arrived.
- **Finding:** the probe has no night samples for that span. Cause not checked: Ring motion schedule or mode, no motion, or a delivery failure.
- **Workaround:** none. A quiet night and a dead webhook look the same in the ledger today.
- **Reproduce:** `jq -r '.received_at[0:13]' webhook-events.jsonl | sort | uniq -c` (webhooks per hour, UTC).

### F-08 The account-link flow starts in the Ring AppStore, not in the console

- **Endpoint:** developer console "Connect Ring account"; `POST /token-exchange`; `GET /link`.
- **Observed:** 10-06, journal from 10-05 21:23.
- **Request ID:** not captured.
- **Finding:** the console button only authorizes an account to see the private app and sends nothing to our endpoints; the journal stayed empty until the AppStore approval at 16:28:42 CDT on 10-06. The token-exchange POST carries exactly `code` and `client_id`; the docs do not name the field.
- **Cost:** about 19 hours of waiting on a callback that could not arrive.
- **Workaround:** `extractCode` accepts the likely spellings; the flow is written down in `docs/recon.md`.
- **Reproduce:** `docs/recon.md`, "Linking is started from the Ring AppStore".

### F-09 Device encryption (TAKE and E2EE) can make video unreadable while requests still succeed

- **Endpoint:** `GET /v1/devices/{id}/configurations`, field `data.attributes.e2e_encryption.enabled` (boolean).
- **Observed:** instrumented 2026-10-11 (`src/encryption.ts`); not yet measured on our cameras.
- **Request ID:** recorded in `friction.jsonl` once the build runs.
- **Finding:** Ring documents that for an encrypted device video requests succeed and return content the app cannot read. The configurations response is the only place the flag appears in the documentation read; it is not in the `include=configurations` table.
- **Cost:** without a check, an encrypted camera would look like a camera that saw nothing.
- **Workaround:** the service reads the flag at startup and every 30 minutes; an encrypted camera gets no frame request and its events are ledger lines marked `blind: camera video is encrypted`. A frame that is not JPEG bytes is refused as `not_jpeg_bytes` even when the flag could not be read. The Playground sandbox switch is not built: its base URL and token flow are not in `api-documentation.html`.
- **Reproduce:** `test/encryption.test.ts` for the logic; on the real service, `grep e2e_encryption friction.jsonl` once the build has run.

### F-10 Every image carries a Ring watermark

- **Endpoint:** media download responses.
- **Observed:** 10-06, every image.
- **Request ID:** not captured.
- **Finding:** the watermark holds a device ID suffix, "Partner: Quiet Porch" and the generation time.
- **Cost:** it is in the frames Bedrock sees and in any footage we show. Whether it counts as a third-party mark under the hackathon rules is an open question; the current plan is to leave it on screen.
- **Workaround:** none.
- **Reproduce:** `docs/recon.md`, "Stored image download"; any frame saved to `~/.local/state/quiet-porch/frames/`.

### F-11 Sandbox and Playground details are missing from the API documentation

- **Endpoint:** n/a (documentation).
- **Observed:** 2026-10-11, `api-documentation.html` read in full for `e2e_encryption`, TAKE and Playground.
- **Finding:** the page lists one API host, `https://api.amazonvision.com`, and no sandbox host or sandbox token flow; "TAKE" appears only as a link to the developer FAQ.
- **Workaround:** none in code. How to reach the Playground is not in the documentation read, so the sandbox switch in F-09 is blocked on that answer.
- **Reproduce:** open `api-documentation.html` and search for `sandbox`, `Playground`, `TAKE`; only the production host and a FAQ link turn up.

## Amazon Bedrock

### F-12 JSON comes back inside a code fence

- **Endpoint:** Bedrock Converse, `global.anthropic.claude-sonnet-4-6`, region `us-east-1`, bearer-key auth.
- **Observed:** 10-06 (gate), recorded in `docs/recon.md`; the parser has handled the fence on every call since without a logged failure.
- **Request ID:** not captured before 2026-10-11; `model-calls.jsonl` from then on.
- **Finding:** with "Return ONLY a JSON object" in the prompt the model still wraps it in a json code fence. First call: `200` in 2428 ms, 378 input and 69 output tokens.
- **Cost:** `JSON.parse` fails on the raw text.
- **Workaround:** `parseModelJson` strips one fenced block and fails closed on anything else (prose around the object); a parse failure closes the event at L0 as "perception failed".
- **Reproduce:** `test/bedrock.test.ts`; `docs/recon.md`, "Bedrock vision".

### F-13 Two model calls per person event put the decision 8 to 12 s after the event

- **Endpoint:** Bedrock Converse (perception, then critique).
- **Observed:** 10-07 21:07Z and 21:38Z for `human` and `motion`.
- **Request ID:** `model-calls.jsonl` from 2026-10-11.
- **Finding:** frames are ready 1.8 s to 6.3 s after the event and decisions land 8 to 12 s after it; two calls take about 6 s.
- **Cost:** the 15 s evidence-age rule leaves about 3 s of slack on the slowest events.
- **Workaround:** the second call runs only when a person or a configured nuisance species was seen (`needsCritique`).

## MCP and Alexa+

### F-14 Not yet tested against a real Alexa+ device

- **Endpoint:** `quiet-porch-status` MCP server, Streamable HTTP, specification 2025-11-25, tools only, single JSON responses, no SSE stream.
- **Observed:** curl and a browser against the simulated page at `/alexa` on 10-07; the ledger tools (`get_night_report`, `get_ledger`, `expect_me`) added 2026-10-11.
- **Finding:** protocol behaviour (initialize, `tools/list`, 401 without a token, 405 on GET, Origin check) is covered by `test/mcp.test.ts` and `test/mcp-night.test.ts`. No real Echo or Alexa+ client has called the server, so friction on that side is unmeasured.
- **Workaround:** the simulated page maps spoken phrases to the same tools.
- **Reproduce:** `npx vitest run test/mcp.test.ts test/mcp-night.test.ts`.

## Amazon Polly

### F-15 Generative voice: four lines timed, one run each

- **Endpoint:** Amazon Polly, voice Ruth, generative engine, `us-east-1`.
- **Observed:** 2026-10-13, attended session.
- **Request ID:** not recorded in the validation record.
- **Finding:** the four approved lines synthesized in 476 ms ("You're on camera.", 1.192 s of audio), 808 ms (with "The owner has been notified.", 2.939 s), 558 ms (with "at the front yard", 1.960 s) and 880 ms (both, 3.707 s), as WAV PCM s16le mono 16 kHz. With the provider forced to fail, 4 of 4 cached lines were served from the cache, and two uncached driveway lines fell back to the matching cached truthful line.
- **Cost:** well under the 3 s target. These are component timings from one run per line; no Ring-event-to-audio latency has been measured.
- **Workaround:** the lines come from a closed vocabulary and are synthesized ahead of time, so a Polly outage plays a cached line that is still true and never a different claim or silence.
- **Reproduce:** `npx vitest run test/voice.test.ts` covers the composer. The synthesis timings are from the attended session recorded in `docs/delivery/validation.txt` (reported, not re-run).

## Raspberry Pi speaker

### F-16 A Bluetooth speaker drops the first 2 to 7 s of every clip

- **Endpoint:** Raspberry Pi with an Anker SoundCore Bluetooth speaker (A2DP), PipeWire, `scripts/pi/qp-play` and `qp-speak`.
- **Observed:** 2026-10-13, attended session; Matt at the speaker.
- **Request ID:** not applicable (local hardware).
- **Finding:** the start of every clip played after idle was lost. Two causes: PipeWire suspended the idle A2DP sink and took about 7 s to resume, and the speaker muted its amplifier on silence and took about 2 s to wake.
- **Cost:** a spoken line of 1 to 4 s could be inaudible. An earlier dispatch run of 770 ms came before the fix, when the audio was lost, and is not used.
- **Workaround:** `scripts/pi/qp-speaker-setup` installs a WirePlumber rule (A2DP pinned, suspend timeout 0, no pause on idle) and a user unit that loops an inaudible 20 Hz tone at -40 dBFS. After 2 minutes of idle the full line "You're on camera at the front yard. The owner has been notified." was heard; dispatch to the start of playback took 865 ms (one run, the time the Pi began playback rather than a measured time to audible sound).
- **Reproduce:** attended only. Let the speaker idle for 2 minutes, then send a line through `qp-speak`. Session evidence QP-15 and QP-16 is summarised in `docs/delivery/validation.txt`.

## Ring live view

### F-17 Live view decodes, but carries no reference timestamp

- **Endpoint:** Ring live view, receive-only RTSPS sessions to camera 1 (battery sessions last up to 30 s, line-powered up to 60 s, per the documentation).
- **Observed:** 2026-10-12, three sessions, 58.478 s in total.
- **Request ID:** not recorded in the spike write-up.
- **Finding:** H.264 decoded (13 samples), but none carried a reference-timestamp meta sample, and the SDP advertised neither `a=ts-refclk` nor `a=mediaclk`. Stream PTS is session-relative and local receipt time includes network, relay and decoder delay of unknown size, so neither is a capture time.
- **Cost:** the 6 s freshness gate cannot be applied to a live frame, so live frames cannot trigger outputs and the ladder keeps the recorded event clip as its evidence.
- **Workaround:** `LIVE_CAPTURE_NO_GO` in `src/capture-time.ts` labels every decoded live frame `arrival` and `createLiveSource` rejects it. `deriveCaptureTime` would accept a stream reference only from an allowlisted clock within 250 ms ahead of and 2000 ms behind receipt, and only with an explicit policy switch.
- **Reproduce:** `docs/delivery/live-view-spike.md` and `docs/delivery/capture-time-provenance.md`; `npx vitest run test/live-decoder.test.ts`.

## Product feedback for Amazon

Each item follows from an entry above.

1. Name the request-ID response header in the API documentation; we matched it by shape (F-01).
2. Document `TIME_RANGE_NOT_AUTHORIZED` and the link-time boundary (F-04).
3. Say in the media-download docs how long a recording runs after the triggering event, and that `at_timestamp` can answer `416` for several seconds first (F-01, F-05).
4. State the expected delay of `other_motion` webhooks, or send them when the classification is not final (F-02).
5. Name the field of the token-exchange POST (F-08), and say in the console that linking starts in the AppStore.
6. Put `e2e_encryption` in the `include=configurations` documentation and publish the Playground host and token flow (F-09, F-11).
7. Expose an absolute capture time for live-view frames, for example an RTCP sender-report NTP time or `a=ts-refclk` in the SDP, and say which clock it comes from (F-17).
