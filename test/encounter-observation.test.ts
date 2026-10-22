import { afterEach, expect, it, vi } from 'vitest';
import { createYardMonitor } from '../src/yard-monitor.ts';
import { pollEncounterObservation } from '../src/encounter-observation.ts';
import { stopForRuntimeFault } from '../src/monitor-diagnostics.ts';

const scope = { accountId: 'fixture-owner', deviceId: 'fixture-camera', zone: 'front_yard' };
const all: ReturnType<typeof createYardMonitor>[] = [];
afterEach(async () => {
  await Promise.all(all.splice(0).map((m) => m.stop('fixture_cleanup')));
  vi.useRealTimers();
});
async function rig() {
  vi.useFakeTimers();
  let now = 100000,
    killed = false,
    authorized = true,
    night = true;
  const rows: Record<string, unknown>[] = [];
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const factory = vi.fn(() => outputs);
  const reserve = vi.fn();
  const audit = (row: Record<string, unknown>) => rows.push(row);
  const monitor = createYardMonitor({
    scope,
    authorized: () => authorized,
    killed: () => killed,
    night: () => night,
    ready: async () => true,
    outputs: factory,
    audit,
    reserve,
    initialCooldown: 0,
    now: () => now,
    mono: () => now,
  });
  all.push(monitor);
  await monitor.feed({
    ...scope,
    id: 'initial',
    source: 'ring',
    captureTs: now,
    verdict: 'person',
  });
  const encounter = monitor.current()!;
  const observe = (poll: () => Promise<undefined>) =>
    pollEncounterObservation(encounter, poll, audit)
      .then(async (frame) => {
        await monitor.tick();
        if (frame) await monitor.feed(frame);
      })
      .catch(async (error) => {
        await stopForRuntimeFault(monitor, audit, 'observe', error, () => now);
      });
  const pending = () =>
    observe(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          const signal = AbortSignal.any([encounter.signal, AbortSignal.timeout(4000)]);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
  const wake = () =>
    monitor.wake({ ...scope, id: `wake-${now}`, source: 'ring_event', eventTs: now });
  return {
    monitor,
    encounter,
    outputs,
    factory,
    rows,
    reserve,
    audit,
    observe,
    pending,
    wake,
    at: (ms: number) => {
      now = 100000 + ms;
    },
    kill: () => {
      killed = true;
    },
    revoke: () => {
      authorized = false;
    },
    clearRevocation: () => {
      killed = false;
      authorized = true;
    },
    day: () => {
      night = false;
    },
  };
}

it('watchdog cancellation cleans up once and preserves cooldown before accepting a new event', async () => {
  const r = await rig();
  const pending = r.pending();
  r.at(6000);
  await r.monitor.tick();
  await pending;
  expect(r.monitor.status()).toMatchObject({ running: true, phase: 'COOLDOWN' });
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.rows.filter((row) => row.event === 'encounter_ended')).toHaveLength(1);
  expect(r.rows.some((row) => row.event === 'runtime_fault')).toBe(false);
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'encounter_observation_cancelled', routine_end: true }),
  );
  await r.wake();
  expect(r.factory).toHaveBeenCalledTimes(1);
  r.at(661000);
  await r.monitor.tick();
  expect(r.monitor.status().phase).toBe('ARMED_WAITING');
  expect(r.factory).toHaveBeenCalledTimes(1); // Waiting itself never starts an encounter.
  await r.wake();
  expect(r.factory).toHaveBeenCalledTimes(2);
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
});

it('joins delayed cleanup before collecting and never declares a cleanup in progress failed', async () => {
  const r = await rig();
  let finish!: () => void;
  r.outputs.stop.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = r.pending();
  r.at(6000);
  const first = r.monitor.tick();
  const second = r.monitor.tick();
  await Promise.resolve();
  expect(r.monitor.status()).toMatchObject({ running: true, phase: 'ENCOUNTER' });
  expect(r.rows.some((row) => row.event === 'encounter_ended')).toBe(false);
  finish();
  await Promise.all([first, second, pending]);
  expect(r.monitor.status()).toMatchObject({ running: true, phase: 'COOLDOWN' });
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.rows.filter((row) => row.event === 'encounter_ended')).toHaveLength(1);
});

it.each(['manual', 'kill', 'revoke', 'encounter_disarm'] as const)(
  'never rearms after %s during inference',
  async (reason) => {
    const r = await rig();
    const pending = r.pending();
    if (reason === 'manual') await r.monitor.stop('SIGTERM');
    else if (reason === 'encounter_disarm') await r.encounter.disarm();
    else {
      r[reason]();
      await r.monitor.tick();
    }
    await pending;
    expect(r.monitor.status()).toMatchObject({ running: false, phase: 'DISARMED' });
    r.at(700000);
    await r.monitor.tick();
    await r.wake();
    expect(r.factory).toHaveBeenCalledTimes(1);
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
    expect(r.outputs.speak).not.toHaveBeenCalled();
  },
);

it('night end cancels inference and returns to daytime idle without outputs', async () => {
  const r = await rig();
  const pending = r.pending();
  r.day();
  await r.monitor.tick();
  await pending;
  expect(r.monitor.status()).toMatchObject({ running: true, phase: 'DAYTIME_IDLE' });
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});

it.each(['kill', 'revoke'] as const)(
  'latches off when the encounter observes transient %s before the condition clears',
  async (method) => {
    const r = await rig();
    r[method]();
    await r.encounter.tick(); // Inner watchdog sees the revoked condition first.
    expect(r.encounter.status().endReason).toBe(
      method === 'kill' ? 'emergency_disarm' : 'authority_revoked',
    );
    r.clearRevocation(); // Outer collection must retain that observed revocation.
    await r.observe(async () => {
      throw r.encounter.signal.reason;
    });
    expect(r.monitor.status()).toMatchObject({ running: false, phase: 'DISARMED' });
    r.at(700000);
    await r.wake();
    expect(r.factory).toHaveBeenCalledTimes(1);
  },
);

it.each(['model_error', 'provider_timeout', 'unrelated_abort'] as const)(
  'latches off on genuine %s',
  async (kind) => {
    const r = await rig();
    const error =
      kind === 'model_error'
        ? new TypeError('SECRET')
        : new DOMException('SECRET', kind === 'provider_timeout' ? 'TimeoutError' : 'AbortError');
    await r.observe(async () => {
      throw error;
    });
    expect(r.monitor.status()).toMatchObject({ running: false, reason: 'source_or_runtime_fault' });
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
    expect(r.rows).toContainEqual(expect.objectContaining({ event: 'runtime_fault' }));
    expect(JSON.stringify(r.rows)).not.toContain('SECRET');
    r.at(700000);
    await r.wake();
    expect(r.factory).toHaveBeenCalledTimes(1);
  },
);

it('an unrelated AbortError racing with a routine end remains fatal', async () => {
  const r = await rig();
  let reject!: (error: unknown) => void;
  const pending = r.observe(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  r.at(6000);
  await r.monitor.tick();
  reject(new DOMException('not our cancellation', 'AbortError'));
  await pending;
  expect(r.monitor.status()).toMatchObject({ running: false, reason: 'source_or_runtime_fault' });
});

it('cleanup failure is fatal even when cancellation itself is expected', async () => {
  const r = await rig();
  r.outputs.stop.mockRejectedValueOnce(new Error('SECRET'));
  const pending = r.pending();
  r.at(6000);
  await r.monitor.tick();
  await pending;
  expect(r.monitor.status()).toMatchObject({ running: false, phase: 'DISARMED' });
  expect(r.encounter.status().cleanupSucceeded).toBe(false);
  r.at(700000);
  await r.wake();
  expect(r.factory).toHaveBeenCalledTimes(1);
});

it('drops a late successful observation after watchdog cancellation', async () => {
  const r = await rig();
  let finish!: (value: undefined) => void;
  const pending = r.observe(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  r.at(6000);
  await r.monitor.tick();
  finish(undefined);
  await pending;
  expect(r.monitor.status()).toMatchObject({ running: true, phase: 'COOLDOWN' });
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
});

it('native fetch preserves our abort identity through a combined signal', async () => {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]);
  abort.abort();
  await expect(fetch('data:text/plain,offline-fixture', { signal })).rejects.toBe(
    abort.signal.reason,
  );
});
