# Fresh-trigger correction — prepared, not deployed

Real evidence: Cam1 capture 2026-10-20 21:30:30.256 CDT, received 21:30:31.237,
frame ready at +3.506s, perception 2.563s, critique 2.326s, completed at +8.404s.
Ring ingested correctly, the owner/camera reader matched, and classification returned person.
The old monitor then rejected that frame under its six-second trigger-age rule. It never
opened an encounter or attempted Telegram or speech. Matt confirmed the notification was
Ring only. This is not an upstream missing-event or speaker-output failure.

The candidate separates four boundaries:

1. Newly ingested signed Ring motion metadata wakes a bounded observation window immediately,
   before a model decision exists. It is not a person observation and cannot start dwell or
   produce output. It retains exact owner/camera/zone, night hours, 15-second metadata recency,
   duplicate suppression, one active encounter, durable cooldown and 60-second observation cap.
2. The existing recorded-image API supplies new pixels with real capture timestamps. Missing,
   snapshot, repeated, future or expired frames are rejected. No receipt time is relabeled as
   capture time; no old model decision is imported as fresh evidence.
3. Perception and an independent visual critique run concurrently on the same frame. Both
   validate their evidence ID, person presence must agree, and benign/uncertain/context vetoes
   remain. The normal decision rules still apply. Each request may take up to four seconds,
   but the completed observation must still be under six seconds old. This avoids the old
   sequential model bottleneck and the two-second timeout that was below measured latency.
4. Dwell uses only advancing accepted person captures. Alert at 10 seconds and speech at 20
   seconds remain unchanged. Capture freshness is rechecked immediately before dispatch,
   including after speaker preparation. Slow preparation cannot authorize expired pixels.

Fresh observation audits include both model durations, capture time and completion age.
This is a potential functioning path, not proof that real API/model latency will fit. Slow
results still fail closed. No thresholds, light/water exclusions, credentials, household
roles or egress/output destinations change. No actual new model calls or physical tests ran
while preparing this correction.

Code is in a NEW isolated worktree so the running service at commit 1c772dd is untouched.
Deployment requires a brief interruption of only quiet-porch-yard-monitor.service: stop it,
verify disarm/audio idle, point its private launcher at the reviewed corrected checkout,
and start the same unit with Restart=no. Production ingestion service remains running and
its normal pipeline remains dry-run. Persistent cooldown survives; pre-start event cursor
is initialized to current events, so the old walk cannot generate a retrospective alert.
No concurrent monitor or test is allowed. Rollback stops the corrected unit and restores
its prior launcher path/code; no camera or household mapping restoration is involved.

Deployment is pending coordination. Do not stop, restart, change the launch path or deploy
merely because tests pass. No additional walk-through or audio test is needed yet.
