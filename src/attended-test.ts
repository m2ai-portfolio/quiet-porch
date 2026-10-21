// One-shot attended test. No HA adapter, general live switch, or automatic re-arm exists here.
import { randomUUID } from 'node:crypto';
import { diagnostic, safeError } from './monitor-diagnostics.ts';
import type { RecoveryCause } from './fresh-judgement.ts';
import {
  ActionEvidenceExpiredError,
  ActionGuardError,
  createActionGuard,
  type ActionGuard,
} from './action-guard.ts';

export interface TestScope {
  accountId: string;
  deviceId: string;
  zone: string;
}
export interface TestEvidence extends TestScope {
  id: string;
  captureTs: number;
  source: 'ring';
  verdict: 'person' | 'empty' | 'uncertain';
}
export interface TestOutputs {
  alert(id: string, signal: AbortSignal, allowed: () => boolean, guard: ActionGuard): Promise<void>;
  speak(id: string, signal: AbortSignal, allowed: () => boolean, guard: ActionGuard): Promise<void>;
  stop(): Promise<void>;
}
export function createAttendedTest(deps: {
  scope: TestScope;
  outputs: TestOutputs;
  authorize: (scope: TestScope) => boolean;
  ready: () => Promise<boolean>;
  killed: () => boolean;
  windowOpen?: () => boolean;
  audit: (row: Record<string, unknown>) => void;
  wall?: () => number;
  mono?: () => number;
}) {
  const wall = deps.wall ?? Date.now;
  const mono = deps.mono ?? (() => performance.now());
  const id = randomUUID();
  const abort = new AbortController();
  let state: 'disarmed' | 'armed' | 'ended' = 'disarmed';
  let started = 0,
    first = 0,
    last = 0,
    lastSeen = 0,
    // After a dwell reset nothing captured at or before this time may start a segment.
    floor = -Infinity,
    segments = 0,
    dwellResets = 0;
  let entered = false,
    alerted = false,
    spoken = false,
    held = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let ending: Promise<void> | undefined;
  let cleanupSucceeded: boolean | undefined;
  let endReason: string | undefined;
  let queue = Promise.resolve();
  const seen = new Set<string>();
  const record = (event: string, data: Record<string, unknown> = {}) =>
    deps.audit({ session: id, utc: new Date(wall()).toISOString(), event, ...data });
  async function end(reason: string) {
    if (ending) return ending;
    endReason = reason;
    state = 'ended'; // Invalidate synchronously, including during an in-flight output.
    abort.abort();
    clearInterval(watchdog);
    ending = (async () => {
      // An unavailable audit sink must never prevent physical cleanup.
      try {
        await deps.outputs.stop();
        cleanupSucceeded = true;
      } catch (error) {
        try {
          cleanupSucceeded = false;
          record('cleanup_failed', safeError(error));
        } catch {
          /* owner must inspect audio */
        }
      }
      try {
        record('ended', { reason });
      } catch {
        /* remain disarmed */
      }
    })();
    return ending;
  }
  function unsafeReason(): string | undefined {
    if (state !== 'armed') return 'not_armed';
    if (deps.killed()) return 'emergency_disarm';
    if (!deps.authorize(deps.scope)) return 'authority_revoked';
    if (deps.windowOpen && !deps.windowOpen()) return 'night_window_ended';
    if (mono() < started || (entered && mono() < lastSeen)) return 'clock_reversed';
    if (mono() - started >= 60000) return 'session_expired';
    if (entered && mono() - lastSeen >= 6000) return 'evidence_lost';
    return undefined;
  }
  function safe() {
    return unsafeReason() === undefined;
  }
  async function tick() {
    try {
      if (state === 'armed') {
        const reason = unsafeReason();
        if (reason) await end(reason);
      }
    } catch {
      await end('guard_failed');
    }
  }
  async function output(kind: 'alert' | 'speak') {
    const canDispatch = () => safe() && wall() - last >= 0 && wall() - last < 6000;
    const guard = createActionGuard({ captureTs: last, wall, mono, unsafeReason });
    guard.assert();
    record(`${kind}_intent`); // durable caller journal before dispatch; no retries on ambiguity
    const outputStarted = mono();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      guard.assert();
      await Promise.race([
        deps.outputs[kind](id, abort.signal, canDispatch, guard),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DOMException('output_timeout', 'TimeoutError')),
            3000,
          );
        }),
      ]);
      if (!safe()) {
        await end('output_late_or_disarmed');
        return;
      }
      record(`${kind}_ack`); // delivery/playback request acknowledged, not human confirmation
    } catch (error) {
      diagnostic(deps.audit, {
        session: id,
        event: 'output_failed',
        output: kind,
        failed_at: wall(),
        elapsed_ms: mono() - outputStarted,
        ...safeError(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    signal: abort.signal,
    status: () => ({
      id,
      state,
      alerted,
      spoken,
      cleanupSucceeded,
      endReason,
      encounterStarted: entered,
      dwellResets,
    }),
    async arm() {
      if (state !== 'disarmed') throw new Error('one_shot_session');
      // No async readiness operation may re-arm a session disarmed while it was pending.
      try {
        if (
          !deps.authorize(deps.scope) ||
          deps.killed() ||
          (deps.windowOpen && !deps.windowOpen()) ||
          !(await deps.ready()) ||
          !deps.authorize(deps.scope) ||
          deps.killed() ||
          (deps.windowOpen && !deps.windowOpen()) ||
          state !== 'disarmed'
        )
          throw new Error('not_ready_or_authorized');
        record('armed', {
          scope: deps.scope,
          duration_ms: 60000,
          profile: 'attended-10-20-40-no-water-no-lights',
        });
        started = mono();
        state = 'armed';
        watchdog = setInterval(() => {
          void tick();
        }, 250);
      } catch (error) {
        await end('arm_failed');
        throw error;
      }
    },
    feed(ev: TestEvidence) {
      queue = queue
        .then(async () => {
          if (state !== 'armed') return;
          if (!safe()) {
            await end('guard_failed');
            return;
          }
          const scope = deps.scope;
          if (
            ev.accountId !== scope.accountId ||
            ev.deviceId !== scope.deviceId ||
            ev.zone !== scope.zone
          ) {
            record('rejected_scope');
            return;
          }
          const age = wall() - ev.captureTs;
          if (
            ev.source !== 'ring' ||
            !Number.isFinite(age) ||
            age < 0 ||
            age >= 6000 ||
            ev.captureTs < wall() - (mono() - started) ||
            seen.has(ev.id) ||
            ev.captureTs <= floor ||
            (entered && ev.captureTs <= last)
          ) {
            record('rejected_evidence');
            return;
          }
          if (entered && ev.captureTs - last >= 6000) {
            await end('capture_gap');
            return;
          }
          seen.add(ev.id);
          record('evidence', { evidence_id: ev.id, capture_ts: ev.captureTs, verdict: ev.verdict });
          if (ev.verdict !== 'person') {
            await end(ev.verdict === 'empty' ? 'departure' : 'uncertain');
            return;
          }
          if (!entered) {
            first = ev.captureTs;
            entered = true;
            record(segments++ === 0 ? 'encounter_started' : 'dwell_restarted');
          }
          last = ev.captureTs;
          lastSeen = mono();
          const dwell = last - first;
          if (dwell >= 10000 && !alerted) {
            alerted = true;
            await output('alert');
          }
          if (state === 'armed' && dwell >= 20000 && !spoken) {
            spoken = true;
            await output('speak');
          }
          if (state === 'armed' && dwell >= 40000 && !held) {
            held = true;
            record('hold_no_additional_outputs');
          }
        })
        .catch(async (error) => {
          // end() preserves an already-latched watchdog/disarm reason. A genuine
          // transport failure must not become routine because its message resembles expiry.
          const reason =
            error instanceof ActionEvidenceExpiredError
              ? (unsafeReason() ?? 'action_evidence_expired')
              : error instanceof ActionGuardError
                ? error.reason
                : 'failure';
          await end(reason);
        });
      return queue;
    },
    // Discards continuous dwell after a failed observation the controller never received.
    // Encounter identity, its 60-second deadline, seen evidence and output flags remain,
    // so an alert already sent is never repeated. Refused once evidence is already lost.
    restartDwell(failedCaptureTs: number, reason: RecoveryCause): Promise<boolean> {
      const restarted = queue.then(async () => {
        if (state !== 'armed' || !Number.isFinite(failedCaptureTs) || !safe()) return false;
        floor = Math.max(floor, last, failedCaptureTs);
        entered = false;
        dwellResets++;
        record('dwell_reset', {
          reason,
          failed_capture_ts: failedCaptureTs,
          alerted,
          spoken,
        });
        return true;
      });
      queue = restarted.then(
        () => undefined,
        () => undefined,
      );
      return restarted;
    },
    tick,
    disarm: (reason = 'emergency_disarm') => end(reason),
  };
}
