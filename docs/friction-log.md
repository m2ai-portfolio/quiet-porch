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

#### 2026-10-20: completed-decision timing blocked the yard monitor (app integration)

- **Endpoint:** Ring `motion_detected` ingestion and recorded-image download, then Bedrock Converse through the existing perception/critique path.
- **Observed:** real Cam1 capture 10-21 02:30:30.256Z (10-20 21:30:30.256 CDT); receipt 02:30:31.237Z; decision 02:30:38.660Z. Corrected sidecar deployment verified at 02:57:41.997Z. A later real retest captured at 03:24:40.595Z reached the webhook at 03:24:41.528Z, woke the corrected monitor at 03:24:41.572Z and armed at 03:24:42.901Z. It stopped on `source_or_runtime_fault` at 03:25:04.253Z.
- **Request ID:** Bedrock `299c2c4f-9885-4e5b-b569-a72da2ee6b55` and `09059d73-8c81-4bf1-ad94-141d11cbf9ae`, from `model-calls.jsonl`. Ring media request IDs were not correlated in this incident note; none are inferred.
- **Finding:** the frame was ready after 3506 ms; perception and critique took about 2563 ms and 2326 ms sequentially. The completed decision was 8404 ms after capture. Account/camera mapping and the reader matched, but our new monitor waited for that decision and then required evidence younger than 6000 ms to open an encounter. It therefore opened none. This is an app integration timing defect interacting with measured media/model latency, not evidence that Ring failed to deliver the event or that Bedrock malfunctioned.
- **Cost:** no Quiet Porch Telegram or speech request was attempted. Matt confirmed the notification received was Ring only. A model's description of one still frame did not establish the 10-second alert or 20-second speech dwell thresholds; this event is not a successful automated deterrence run or a Bluetooth failure.
- **Workaround:** commit `fe540e6` reads newly ingested event metadata as a bounded observation wake-up, not actuation evidence. New recorded frames retain real capture timestamps. Perception and independent visual critique run in parallel on the same frame, with validation, person-presence agreement and benign/uncertain vetoes. Completed evidence and dispatch must still be younger than six seconds, including after speaker preparation; dwell stays at 10/20 seconds. The existing scoped night monitor, finite encounters, cooldown and emergency disarm remain; lights and sprinklers are excluded. The local candidate `fe540e6` passed 119 offline regression tests plus typechecks/lint and was deployed locally by restarting only the sidecar; ingestion stayed healthy. An individual 8.4-second inference still cannot pass this freshness limit. The later real retest verified five parallel analyses completing 4895–5250 ms after capture. The first capture preceded arming and was rejected; four accepted person captures covered 9997 ms, below the 10000 ms alert and 20000 ms speech thresholds. No alert/speech intents or acknowledgements occurred before the runtime fault. The wake/parallel-analysis fix is demonstrated; a full live response is not. The runner discarded the underlying exception, so a camera/model timeout or other provider failure cannot be attributed from retained records. Sanitized failure-stage diagnostics are prepared in a separate local candidate, with thresholds and fail-closed behavior preserved; they have not been deployed and do not establish the historical exception cause. The implementation and its new tests are local candidate evidence, not included in this documentation-only change.
- **Reproduce (2026-10-20 note):** inspect the event's capture/receipt/decision timestamps and `timings` in `decisions.jsonl`, matching Bedrock request IDs in `model-calls.jsonl`, and the sidecar's `yard-monitor-*.jsonl` for wake/observation/intent/ack/end records.

#### 2026-10-21: the six-second freshness limit leaves 0.5 to 1.2 s of margin per frame

- **Endpoint:** Ring recorded-image download, then parallel perception and critique (Bedrock Converse) on the same frame.
- **Observed (measured):** every real-camera frame pair judged by the bounded runners on 10-20 and 10-21: 23 pairs. 18 were accepted at 4,848 to 5,464 ms image age. 3 completed past the limit (late call at 6,107, 6,506 and 6,669 ms image age; two were critique-bound, one perception-bound). 2 returned HTTP 503 (F-19). Two cancelled pairs from a run that ended on a runtime fault are excluded.
- **Request ID:** retained privately in the run journals.
- **Finding:** a frame is about 2.4 to 2.7 s old when its download completes (one outlier: 3.8 s), because the observer asks Ring for the frame 2 s in the past; Ring answers `416 MEDIA_NOT_FOUND` for a timestamp about 1 to 1.5 s after the event (F-01). That leaves about 3.3 to 3.6 s for the slower of two model calls, whose median is about 2.6 s. Polls are about 3.5 to 4.4 s apart, so one stale or failed frame in the middle of an encounter opens a gap of about 7 s. The controller then ends the encounter on `evidence_lost` (6 s without accepted evidence). One bad frame ends the encounter.
- **Cost (estimate, not a measurement):** with the measured rates (78% accepted, 13% stale, 9% 503 per pair), a simple model of a continuously present person gives about a 21% chance of reaching the 20 s speech threshold in one 60 s encounter. With the one-shot 503 recovery below, about 29%. Recovering once from either a 503 or a stale frame gives about 37%. The model assumes independent failures and a 3.6 s cycle, and is based on 23 pairs.
- **Hypothesis, not established:** the base ingestion pipeline judged the same event in parallel. Its two Bedrock calls ran 15:03:05.123Z to 15:03:10.590Z, overlapping the attended run's first two frames. The first frame's perception call took 3,449 ms and missed the limit by 107 ms. A later frame with no overlap took 2,985 ms, so the overlap is not shown to be the cause.
- **Workaround (offline candidate, not deployed):** none that changes the limit; freshness stays at six seconds. Matt chose (10-21) to let the one-shot recovery in F-19 also cover a stale result, sharing its single budget. With the policy's stale cause listed, a judgement that completes six seconds or more after capture, inside an encounter that has started dwell, restarts dwell on a strictly newer frame instead of letting the encounter run into `evidence_lost`. The stale frame is never evidence. A late result before any dwell, or after the recovery is spent, is dropped silently as before and never becomes a fault. Frames already too old on arrival are not covered.
- **Reproduce:** pair `model_completed`/`model_failed` rows by `poll` in the private run journals, and compare `age_at_completion_ms` with 6000. Offline regression on local candidate `fe540e6` (these new test files are not yet on main): `npx vitest run test/fresh-trigger.test.ts test/yard-monitor.test.ts test/attended-test.test.ts test/attended-observer.test.ts test/attended-source.test.ts test/attended-download.test.ts test/attended-schedule.test.ts test/pipeline.test.ts test/frames.test.ts test/server.test.ts`. Physical observation remains separate from mocks; record actual capture ages, critique decisions and dispatch outcomes, then separately confirm phone receipt and speech heard.

### F-19 Bedrock Converse returns HTTP 503 on single calls

- **Endpoint:** Bedrock Converse, `global.anthropic.claude-sonnet-4-6`, region `us-east-1`, bearer-key auth. Body: `"Bedrock is unable to process your request."`
- **Observed (measured):** 5 of 145 calls logged from 10-15 to 10-21. Base pipeline: 3 of 121 (10-18 02:39:55Z; 10-21 06:32:20Z and 15:04:49Z), each with no attended run in progress. Attended runs: 2 of 12 real-camera calls (10-21 07:40:31Z overnight, 15:03:18Z daylight). The 12-call synthetic check at 14:45Z returned 12 of 12 `200`.
- **Request ID:** retained privately (`model-calls.jsonl` and the run journals).
- **Finding:** both attended 503s were on the perception call, after 2,328 and 2,293 ms, while the critique of the same frame returned `200` in 2,250 and 2,247 ms. Both frames were still fresh (4,823 and 4,781 ms). No base-pipeline Bedrock call was in flight during either one: overnight, the base calls started at 07:40:35.624Z, after the 503 at 07:40:33.986Z; in daylight, they ended at 15:03:10.590Z, before the failed request started at 15:03:18.576Z. Local overlapping inference is therefore not supported as the cause. The upstream cause, and whether 503s cluster in time, are unknown. Two perception-only failures are too few to say the perception call is more exposed.
- **Cost:** in each attended run, the 503 ended the encounter before any output. The daylight run had already accepted 6,936 ms of person dwell, below the 10 s alert threshold.
- **Workaround (offline candidate, not deployed):** with an explicit policy recovery (`causes` includes `model_unavailable_503`), a typed HTTP 503 aborts and drains the frame's other model request and discards both results. The same encounter then waits for a strictly newer frame and restarts continuous dwell from zero. This happens once per run, and the budget is shared with the optional stale cause (F-13 2026-10-21 note); a second 503, a 503 after a stale recovery, a different sibling failure, undrained work or lost authority stops the run as before. Freshness, the 60 s encounter deadline, request caps, output flags and cooldown are unchanged. An alert already sent is not repeated. It is not a retry of the failed frame and does not fix the provider.
- **Reproduce:** `npx vitest run test/model-unavailable-recovery.test.ts`; base-pipeline errors are the `error` rows in `model-calls.jsonl`.

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

#### 2026-10-21: process acknowledgements do not prove audible speech; clarity accepted

- **Observed:** process acknowledgements on 10-21 overnight did not match what Matt heard: silence, then a stutter after reconnect, then clear speech after a physical power cycle (owner reports). In the morning, Matt reported removing the speaker from other computers' Bluetooth pairings (owner action, not a verified fix). The pinned volume read 36%, later 51%, against the requested 100%. Both times readiness refused before any playback, and the volume was restored. The cause of the drift is unknown.
- **Accepted limitation:** after restoration, one replay was heard about 90% clearly with a slight stutter. Matt accepted that for this stage and asked for no further clarity work.
- **Workaround:** readiness requires exactly 100% before every dispatch and refuses otherwise. A speech acknowledgement is recorded as intermediate evidence only; the owner confirms what was heard.
- **Later (10-21 11:09 CDT):** the first office launch refused at readiness with the Pi reading 36% again. Matt accepted 36% for indoor tests. An office policy may now name its exact level (`speakerVolume`); readiness requires that exact readback, so drift is still refused. Outdoor and ongoing runs keep the 100% rule.

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
