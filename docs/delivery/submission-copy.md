## Inspiration

Outdoor motion alerts can make every event the homeowner’s job. Quiet Porch asks whether a home can respond with restraint and leave an auditable explanation afterward. The team’s motivating examples include benign visits and nuisance wildlife; the public demonstration uses synthetic data to preserve household privacy.

## What it does

Quiet Porch turns Ring motion events into logged decisions. Bedrock describes camera evidence; deterministic code controls escalation and checks freshness. The selected software profile uses an exterior light at ten seconds, descriptive speech at twenty seconds and a bounded sprinkler plan at forty seconds. The current build is locked to dry run: output calls are simulated. Two accepted empty frames stop an incident. Owners can stand down or open a bounded expected-person window. Reports and a ledger explain outcomes, including unknown historical outcomes. The local rehearsal uses hand-built fixtures and a simulated Alexa-style report surface.

## How we built it

The implementation uses TypeScript on Node, SQLite, signed Ring webhooks and Amazon Bedrock. An actuator allowlist enforces exterior zones while preserving stop/close cleanup. Action intents are written before dispatch and their outcomes afterward. Secondary households are ledger-only and have scoped report tools. A closed-vocabulary speech composer connects to a Polly synthesis adapter, finite WAV cache and Pi playback helper, tested with mocks. Live-source session/provenance boundaries are implemented, but a real decoder and trusted absolute capture-time mapping are not validated. ProBook hosts the rehearsal; Pi playback is an integration target, not a claimed deployment.

## Challenges we ran into

The repository’s recon documents delayed frame availability, short clip freshness and missing request IDs in earlier builds. Those are historical team measurements, not remeasured by this rehearsal. New review found that an absent coordinator outcome could look silent, exterior allowlist zones were not enforced, and empty events could imply healthy delivery. The implementation now shows unknown outcomes, rejects wrong-zone escalation and qualifies delivery coverage. No real encryption failure, live-view session or Polly latency is claimed by the current test evidence.

## Accomplishments that we’re proud of

The synthetic night replays through the pipeline and deterministic coordinator with repeatable output. Failure and reverse-state tests exercise stale evidence, zone rejection, Stop, expected-window cleanup, missing outcomes, secondary-household isolation, live-source expiry and speech fallback failure. Reports claim only completed action records and identify dry run. Speech omits the owner-notified statement unless a notification completed. The interactive rehearsal makes the evidence and current limits inspectable.

## What we learned

Restraint needs a record: no events received is not proof that a home stayed quiet, and a missing outcome is not proof of no action. Separating perception from deterministic decisions makes timing and failure behavior testable. Receipt time is also not camera capture time; a live decoder needs trustworthy timestamp provenance before higher escalation can rely on it.

## What’s next

Complete the authorized live-view spike and validate capture-time provenance across battery session renewal. Confirm physical sprinkler zone A’s entity mapping and test bounded shutoff, Stop and recovery in an attended session. Measure actual Pi speech latency, connect a consenting second household in ledger-only mode, and capture the final Ring device or simulator demonstration. Caretaking, accessibility and native Ring-speaker output remain future concepts rather than current features.
