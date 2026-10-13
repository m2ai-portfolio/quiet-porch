## Inspiration

Outdoor motion alerts can make every event the homeowner’s job. Quiet Porch asks whether a home can respond with restraint and leave an auditable explanation afterward. The team’s motivating examples include benign visits and nuisance wildlife; the public demonstration uses synthetic data to preserve household privacy.

## What it does

Quiet Porch turns Ring motion events into logged decisions. Bedrock describes camera evidence; deterministic code controls escalation and checks freshness. The selected software profile skips the exterior light at ten seconds, because zone A has none, and uses descriptive speech at twenty seconds and a bounded sprinkler plan at forty seconds. The current build is locked to dry run: output calls are simulated. Two accepted empty frames stop an incident. Owners can stand down or open a bounded expected-person window. Reports and a ledger explain outcomes, including unknown historical outcomes. The local rehearsal uses hand-built fixtures and a simulated Alexa-style report surface.

## How we built it

The implementation uses TypeScript on Node, SQLite, signed Ring webhooks and Amazon Bedrock. An actuator allowlist enforces exterior zones while preserving stop/close cleanup. Action intents are written before dispatch and their outcomes afterward. Secondary households are ledger-only and have scoped report tools. A closed-vocabulary speech composer feeds an Amazon Polly synthesis adapter (voice Ruth, generative engine, us-east-1), a finite WAV cache and the Pi playback helper. On 2026-10-13 Polly synthesized four approved lines into a private cache on ProBook in 476 to 880 ms per line. With the provider forced to fail, cached lines were served and uncached lines fell back to the matching cached truthful line. Live-source session/provenance boundaries are implemented, but a real decoder and trusted absolute capture-time mapping are not validated. A Raspberry Pi driving an Anker SoundCore Bluetooth speaker played the full spoken line in an attended test on 2026-10-13, with dispatch from ProBook taking 0.77 to 0.87 s. That test drove the Pi adapters directly rather than a live coordinator run from a Ring event, and the normal service still runs dry run. ProBook hosts the rehearsal.

## Challenges we ran into

The repository’s recon documents delayed frame availability, short clip freshness and missing request IDs in earlier builds. Those are historical team measurements, not remeasured by this rehearsal. New review found that an absent coordinator outcome could look silent, exterior allowlist zones were not enforced, and empty events could imply healthy delivery. The implementation now shows unknown outcomes, rejects wrong-zone escalation and qualifies delivery coverage. On hardware, the Bluetooth speaker lost the start of every clip: about 7 seconds while PipeWire resumed a suspended sink, and about 2 seconds while the speaker woke its own amplifier after silence. `qp-speaker-setup` now pins the A2DP sink with no suspend and loops an inaudible 20 Hz keep-alive tone at -40 dBFS. Polly synthesis time is now measured at 476 to 880 ms per line. No real encryption failure or live-view session is claimed by the current test evidence.

## Accomplishments that we’re proud of

The synthetic night replays through the pipeline and deterministic coordinator with repeatable output. Failure and reverse-state tests exercise stale evidence, zone rejection, Stop, expected-window cleanup, missing outcomes, secondary-household isolation, live-source expiry and speech fallback failure. Reports claim only completed action records and identify dry run. Speech omits the owner-notified statement unless a notification completed. The interactive rehearsal makes the evidence and current limits inspectable. On hardware, the homeowner heard the full spoken line at the porch speaker in an attended test, and Stop cut a playing clip with qp-stop returning in 480 ms.

## What we learned

Restraint needs a record: no events received is not proof that a home stayed quiet, and a missing outcome is not proof of no action. Separating perception from deterministic decisions makes timing and failure behavior testable. Receipt time is also not camera capture time; a live decoder needs trustworthy timestamp provenance before higher escalation can rely on it.

## What’s next

Complete the authorized live-view spike and validate capture-time provenance across battery session renewal. Test valve actuation by the app, the 30-second valve self-shutoff, Stop and recovery in an attended session. Measure Ring-event-to-audio latency in a live coordinator run from a real Ring event, connect a consenting second household in ledger-only mode, and capture the final Ring device or simulator demonstration. Caretaking, accessibility and native Ring-speaker output remain future concepts rather than current features.
