// Ongoing owner-scoped supervision, distinct from an attended-test approval or its expiry.
// Each genuinely new camera encounter has its own finite controller and durable cooldown.
import type { MotionWake } from './attended-source.ts';
import { routineEncounterEnd } from './encounter-observation.ts';
import {
  createAttendedTest,
  type TestEvidence,
  type TestOutputs,
  type TestScope,
} from './attended-test.ts';
export function createYardMonitor(deps: {
  scope: TestScope;
  authorized: () => boolean;
  night: () => boolean;
  killed: () => boolean;
  ready: () => Promise<boolean>;
  outputs: () => TestOutputs;
  audit: (r: Record<string, unknown>) => void;
  reserve: (until: number) => void;
  initialCooldown: number;
  now?: () => number;
  mono?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let cooldown = deps.initialCooldown,
    running = true,
    reason: string | undefined;
  let encounter: ReturnType<typeof createAttendedTest> | undefined;
  let busy = false;
  let lastWake: string | undefined;
  async function stop(why: string) {
    if (!running) {
      await encounter?.disarm(why);
      return;
    }
    running = false;
    reason = why;
    await encounter?.disarm(why);
    deps.audit({ event: 'monitor_stopped', reason: why });
  }
  function permitted() {
    return running && deps.authorized() && !deps.killed();
  }
  async function collect() {
    if (!encounter || encounter.status().state !== 'ended') return;
    const finished = encounter;
    await finished.disarm(); // Join cleanup even if another watchdog initiated it.
    if (encounter !== finished || !running) return; // Another collector/manual stop won.
    if (!permitted()) {
      await stop('authority_or_emergency_disarm');
      return;
    }
    const result = finished.status();
    deps.audit({ event: 'encounter_ended', ...result });
    cooldown = Math.max(cooldown, now() + 600000);
    deps.reserve(cooldown);
    encounter = undefined;
    if (result.cleanupSucceeded !== true || !routineEncounterEnd(result.endReason))
      await stop('encounter_fault');
  }
  async function openEncounter() {
    // No wake-up frame is fed to this controller. Reserve before any possible outputs.
    cooldown = now() + 660000;
    deps.reserve(cooldown);
    encounter = createAttendedTest({
      scope: deps.scope,
      outputs: deps.outputs(),
      authorize: () => permitted(),
      windowOpen: deps.night,
      ready: deps.ready,
      killed: deps.killed,
      audit: deps.audit,
      wall: now,
      mono: deps.mono,
    });
    await encounter.arm();
  }
  return {
    async wake(ev: MotionWake) {
      if (busy || !running || encounter || now() < cooldown) return;
      busy = true;
      try {
        if (!permitted()) {
          await stop('authority_or_emergency_disarm');
          return;
        }
        if (
          !deps.night() ||
          ev.source !== 'ring_event' ||
          ev.id === lastWake ||
          ev.accountId !== deps.scope.accountId ||
          ev.deviceId !== deps.scope.deviceId ||
          ev.zone !== deps.scope.zone ||
          !Number.isFinite(ev.eventTs) ||
          ev.eventTs > now() ||
          now() - ev.eventTs >= 15000
        ) {
          deps.audit({ event: 'motion_wake_rejected' });
          return;
        }
        // other_motion webhooks arrive about 11 s late and their clip is downloadable only
        // 21 to 26 s after the event, after the clip has ended (friction log F-02, F-05).
        // "now - 2 s" can never hit it, so the 6 s attended path cannot use these wakes.
        if (ev.subType === 'other_motion') {
          deps.audit({
            event: 'motion_wake_rejected',
            reason: 'other_motion_no_fresh_frame',
            event_id: ev.id,
          });
          return;
        }
        lastWake = ev.id;
        deps.audit({
          event: 'motion_wake',
          event_id: ev.id,
          event_ts: ev.eventTs,
          sub_type: ev.subType,
          hint_only: true,
        });
        await openEncounter();
      } catch {
        await stop('monitor_wake_fault');
      } finally {
        busy = false;
      }
    },
    status() {
      return {
        running,
        reason,
        phase: !running
          ? 'DISARMED'
          : !deps.night()
            ? 'DAYTIME_IDLE'
            : encounter
              ? 'ENCOUNTER'
              : now() < cooldown
                ? 'COOLDOWN'
                : 'ARMED_WAITING',
        cooldownUntil: cooldown,
        encounter: encounter?.status(),
      };
    },
    current: () => encounter,
    async tick() {
      if (!running) return;
      try {
        if (!permitted()) {
          await stop('authority_or_emergency_disarm');
          return;
        }
        if (!deps.night()) await encounter?.disarm('night_window_ended');
        await encounter?.tick();
        await collect();
      } catch {
        await stop('monitor_guard_fault');
      }
    },
    async feed(ev: TestEvidence) {
      if (busy || !running) return;
      busy = true;
      try {
        if (!permitted()) {
          await stop('authority_or_emergency_disarm');
          return;
        }
        if (!deps.night()) return;
        if (!encounter) {
          if (
            now() < cooldown ||
            ev.verdict !== 'person' ||
            ev.source !== 'ring' ||
            ev.accountId !== deps.scope.accountId ||
            ev.deviceId !== deps.scope.deviceId ||
            ev.zone !== deps.scope.zone ||
            !Number.isFinite(ev.captureTs) ||
            now() - ev.captureTs < 0 ||
            now() - ev.captureTs >= 6000
          )
            return;
          await openEncounter();
        }
        await encounter!.feed(ev);
        await collect();
      } catch {
        await stop('monitor_encounter_fault');
      } finally {
        busy = false;
      }
    },
    stop,
  };
}
