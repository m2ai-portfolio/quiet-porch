# Yard-monitor diagnostics candidate — not deployed

This candidate is based on `fe540e6`, which successfully woke and produced fresh parallel
judgements in the October 21 03:24 UTC real encounter. It addresses a diagnostic defect:
the runner discarded the exception that ended that encounter at 03:25:04.253 UTC.
It does not claim to fix the still-unknown underlying live fault.

## Evidence and diagnosis limits

The actual event capture was 03:24:40.595 UTC, webhook receipt 03:24:41.528, wake
03:24:41.572 and arming 03:24:42.901. Five successful parallel analyses had capture ages
4895–5250 ms, below the unchanged 6000 ms limit. One pre-arm capture was rejected and
four accepted captures covered 9997 ms. Alert requires 10000 ms and speech 20000 ms.
No alert/speech intents or acknowledgements exist. The terminal record is only
`source_or_runtime_fault`; this does not establish a camera failure, inference timeout,
Bluetooth failure or user departure.

The last read-only audio inspection found the approved Anker selected, connected and
idle at 100% volume, exceeding the existing <=60% readiness ceiling. Readiness passed
when the encounter armed; the later volume observation cannot explain the pre-alert fault.

## Implemented change and preserved controls

Record fixed diagnostic stages, validated exception class/category, HTTP status and safe
provider request IDs; record poll/request/capture and parallel model timing even when one
call fails. Never serialize raw exception messages, response bodies, URLs, prompts,
credentials, images or household/device identifiers. A failed diagnostic sink must not
prevent the existing fail-closed stop/cleanup.

Retain real capture timestamps, six-second freshness, ten/twenty-second dwell gates,
independent critique, finite encounters, output caps, night policy, cooldown and emergency
disarm. No retries, auto-restart, destination/access changes, lights or sprinklers are added.

## Offline validation

- 146 focused tests passed: 130 across 11 suites in the restricted environment and all
  16 server tests with authorized loopback access. The initial combined run could not bind
  loopback in the sandbox; this was a test-environment failure, not a service or API probe.
- 20 new diagnostic tests cover malicious messages/URLs/metadata, throwing getters and
  coercions, safe HTTP/request-ID retention before response-body parsing, each parallel
  model failing first, frame readiness/capture times, cancellation, cleanup despite a broken
  diagnostic sink, failure after accepted evidence, and exact 9997/10000/20000 ms thresholds.
- Project source/test typecheck, standalone runner typecheck, targeted ESLint and Prettier
  checks passed. No changes were made to the controller, supervisor or wake eligibility rules.

Focused suites: `monitor-diagnostics`, `fresh-trigger`, `yard-monitor`, `attended-test`,
`attended-observer`, `attended-source`, `attended-download`, `attended-schedule`, `pipeline`,
`frames`, `bedrock`, and `server` (`test/*.test.ts`). All provider/device outputs were mocked.

Offline reproduction established that a null critique can throw `TypeError` during
validation. Malformed JSON, HTTP errors, timeouts, camera denial and cancellation can also
reach observer failure paths. These are reproducible possibilities; none establishes the
cause of the historical live exception. This candidate preserves those fail-closed outcomes
and records their stages rather than inventing a behavior repair.

Provider request IDs are retained only when they match the UUID allowlist. Other formats
are omitted rather than copied into diagnostic records.

## Proposed next diagnostic action — requires deployment approval

After code review and offline validation, obtain approval for the precise deployment and
speaker-volume correction. Restore the previously verified 37% setting only if approved;
verify the known speaker is selected and idle. Point only the private yard-monitor launcher
to this tested candidate and start the same owner/Cam1 monitor with `Restart=no`, retaining
the existing AWS/phone/speaker scope and persistent cooldown. Ring ingestion stays running.
Capture one subsequent real encounter with the new diagnostic records before proposing
any further behavior repair. Do not repeat a physical walk against a disarmed service.

This preparation does not perform that action. No live camera/model probes, hardware
outputs, service restarts, volume changes, GitHub publication or Library uploads occurred.
Rollback, if a later deployment is authorized, stops the sidecar and restores the prior
launcher target. Restoring old code does not authorize automatic rearming.
