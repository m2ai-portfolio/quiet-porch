# Ongoing yard monitor

Matt's instruction “Just arm the system and leave it running” replaces timed-only operation.
This is a separate supervisor, not an expiry removal or reuse of the consumed test approval.
It scopes one running process to the already completed/claimed owner, mapped Cam1/front_yard,
existing Anker speaker and private Matt Hermes1 route. No primary assignment, credential,
security grant, Home Assistant client, light or sprinkler command is added. Normal production
service and database writers stay unchanged and dry-run.

The supervisor waits for newly ingested, eligible real Ring decisions, opens at most one
60-second encounter, and uses the existing recorded-frame observer and critique/context rules.
Only configured night hours (20:00–06:30 America/Chicago) permit encounters or outputs.
Each encounter permits at most one alert attempt at 10 seconds and one cached neutral speech
request at 20 seconds of valid observed dwell. A frame must remain under six seconds old;
advancing capture timestamps, scope and gap checks remain. Actual empty observations mean
departure; missing frames mean evidence loss. At most 30 image reads and 60 model calls occur
per encounter, with cancellation/deadlines. Live timing and audible/delivery success remain
unproven until actual receipts and owner confirmation exist.

Before arming an encounter, a cooldown reservation is persisted for its maximum 60 seconds
plus ten minutes. Ending may extend that reservation to ensure ten minutes from completion.
Fresh events during cooldown cannot create another encounter. The reservation survives process
restart. No ambiguous alert/speech retries occur; output or cleanup faults stop the supervisor.
Permission loss, emergency disarm and source/runtime faults also stop it. Daylight ends any
active encounter and leaves monitoring idle until the next configured night. No continuously
open camera stream or idle polling of camera footage occurs.

A transient systemd user service runs with Restart=no, is not enabled at boot and does not
restart the production service. Status is private JSON in the existing state directory:
`yard-monitor-status.json`; durable cooldown is `yard-monitor-runtime.json`; audits are
`yard-monitor-*.jsonl`. A recent heartbeat plus active unit/PID verifies process state, not
phone receipt, audible playback or successful perception.

Disarm immediately with:

```sh
systemctl --user stop quiet-porch-yard-monitor.service
```

Alternatively create `~/.local/state/quiet-porch/YARD-MONITOR-DISARM`; existing KILL also
works. The watchdog checks at 250ms intervals. It aborts active requests and performs speaker
cleanup only if speech might have been dispatched. Pi RuntimeMaxSec=4 independently bounds
that finite clip. Cleanup is acknowledged/read back; failures require owner inspection.
The monitor and attended runner reject each other's locks, preventing concurrent output paths.
No automatic restart, rescheduling, lock clearing or disarm-file clearing is performed.

The first attended attempt remains classified as a coordination failure: volunteer never cued,
zero events/decisions/outputs, no camera failure established. Those receipts are preserved.
