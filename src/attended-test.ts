// One-shot attended test. No HA adapter, general live switch, or automatic re-arm exists here.
import { randomUUID } from 'node:crypto';

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
  alert(id: string, signal: AbortSignal): Promise<void>;
  speak(id: string, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}
export function createAttendedTest(deps: {
  scope: TestScope;
  outputs: TestOutputs;
  authorize: (scope: TestScope) => boolean;
  ready: () => Promise<boolean>;
  killed: () => boolean;
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
    lastSeen = 0;
  let entered = false,
    alerted = false,
    spoken = false,
    held = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let ending: Promise<void> | undefined;
  let queue = Promise.resolve();
  const seen = new Set<string>();
  const record = (event: string, data: Record<string, unknown> = {}) =>
    deps.audit({ session: id, utc: new Date(wall()).toISOString(), event, ...data });
  async function end(reason: string) {
    if (ending) return ending;
    state = 'ended'; // Invalidate synchronously, including during an in-flight output.
    abort.abort();
    clearInterval(watchdog);
    ending = (async () => {
      // An unavailable audit sink must never prevent physical cleanup.
      try {
        await deps.outputs.stop();
      } catch {
        try {
          record('cleanup_failed');
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
  function safe() {
    return (
      state === 'armed' &&
      !deps.killed() &&
      deps.authorize(deps.scope) &&
      mono() >= started &&
      mono() - started < 60000 &&
      (!entered || (mono() >= lastSeen && mono() - lastSeen < 6000))
    );
  }
  async function tick() {
    try {
      if (state === 'armed' && !safe()) await end('timeout_stale_kill_or_authority');
    } catch {
      await end('guard_failed');
    }
  }
  async function output(kind: 'alert' | 'speak') {
    if (!safe()) {
      await end('guard_failed');
      return;
    }
    record(`${kind}_intent`); // durable caller journal before dispatch; no retries on ambiguity
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        deps.outputs[kind](id, abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('output_timeout')), 3000);
        }),
      ]);
      if (!safe()) {
        await end('output_late_or_disarmed');
        return;
      }
      record(`${kind}_ack`); // delivery/playback request acknowledged, not human confirmation
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    status: () => ({ id, state, alerted, spoken }),
    async arm() {
      if (state !== 'disarmed') throw new Error('one_shot_session');
      // No async readiness operation may re-arm a session disarmed while it was pending.
      try {
        if (
          !deps.authorize(deps.scope) ||
          deps.killed() ||
          !(await deps.ready()) ||
          !deps.authorize(deps.scope) ||
          deps.killed() ||
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
            (entered && ev.captureTs <= last)
          ) {
            record('rejected_evidence');
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
            record('encounter_started');
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
        .catch(async () => {
          await end('failure');
        });
      return queue;
    },
    tick,
    disarm: (reason = 'emergency_disarm') => end(reason),
  };
}
