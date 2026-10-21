import { afterEach, expect, it, vi } from 'vitest';
import { createYardMonitor } from '../src/yard-monitor.ts';
import type { TestEvidence } from '../src/attended-test.ts';
const scope = { accountId: 'owner', deviceId: 'cam', zone: 'front_yard' };
const all: ReturnType<typeof createYardMonitor>[] = [];
function rig(initialCooldown = 0) {
  let time = 100000,
    night = true,
    allowed = true,
    killed = false;
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const reserve = vi.fn();
  const factory = vi.fn(() => outputs);
  const monitor = createYardMonitor({
    scope,
    authorized: () => allowed,
    night: () => night,
    killed: () => killed,
    ready: async () => true,
    outputs: factory,
    audit: () => {},
    reserve,
    initialCooldown,
    now: () => time,
    mono: () => time - 100000,
  });
  const r = {
    monitor,
    outputs,
    reserve,
    factory,
    at: (s: number) => {
      time = 100000 + s * 1000;
    },
    feed: async (s: number, patch: Partial<TestEvidence> = {}) => {
      time = 100000 + s * 1000;
      await monitor.feed({
        ...scope,
        id: 'e' + s,
        captureTs: time,
        source: 'ring',
        verdict: 'person',
        ...patch,
      });
    },
    day: () => {
      night = false;
    },
    revoke: () => {
      allowed = false;
    },
    kill: () => {
      killed = true;
    },
  };
  all.push(monitor);
  return r;
}
afterEach(async () => {
  await Promise.all(all.splice(0).map((r) => r.stop('test_cleanup')));
});
it('ongoing idle supervision does not create encounters or output', async () => {
  const r = rig();
  for (let s = 0; s < 120; s += 5) {
    r.at(s);
    await r.monitor.tick();
  }
  expect(r.monitor.status().phase).toBe('ARMED_WAITING');
  expect(r.factory).not.toHaveBeenCalled();
});
it('camera encounter emits one alert and one speech, then observed departure and durable cooldown', async () => {
  const r = rig();
  for (let s = 0; s <= 45; s += 5) await r.feed(s);
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  await r.feed(46, { verdict: 'empty' });
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.monitor.status().phase).toBe('COOLDOWN');
  expect(r.reserve).toHaveBeenCalled();
  await r.feed(60);
  expect(r.factory).toHaveBeenCalledTimes(1);
  await r.feed(700);
  expect(r.factory).toHaveBeenCalledTimes(2);
});
it('persisted cooldown survives a supervisor restart', async () => {
  const r = rig(800000);
  await r.feed(0);
  expect(r.factory).not.toHaveBeenCalled();
  expect(r.monitor.status().phase).toBe('COOLDOWN');
});
it('daytime is idle and never actuates, regardless of person events', async () => {
  const r = rig();
  r.day();
  await r.feed(0);
  expect(r.monitor.status().phase).toBe('DAYTIME_IDLE');
  expect(r.factory).not.toHaveBeenCalled();
});
it('night ending disarms the current encounter', async () => {
  const r = rig();
  await r.feed(0);
  r.day();
  await r.monitor.tick();
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.monitor.status().phase).toBe('DAYTIME_IDLE');
});
it.each(['revoke', 'kill'] as const)(
  '%s disarms ongoing supervision and prevents later encounters',
  async (method) => {
    const r = rig();
    await r.feed(0);
    r[method]();
    await r.monitor.tick();
    expect(r.monitor.status().running).toBe(false);
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
    await r.feed(700);
    expect(r.factory).toHaveBeenCalledTimes(1);
  },
);
it('per-encounter missing evidence closes it while preserving cooldown', async () => {
  const r = rig();
  await r.feed(0);
  r.at(6);
  await r.monitor.tick();
  expect(r.monitor.status().phase).toBe('COOLDOWN');
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});
it('ambiguous output failure latches the whole monitor off, without retries', async () => {
  const r = rig();
  r.outputs.alert.mockRejectedValueOnce(new Error('network'));
  await r.feed(0);
  await r.feed(5);
  await r.feed(10);
  expect(r.monitor.status().running).toBe(false);
  await r.feed(700);
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).not.toHaveBeenCalled();
});
it('wrong scope or stale trigger cannot open an encounter', async () => {
  const r = rig();
  await r.feed(0, { accountId: 'other' });
  await r.feed(0, { deviceId: 'other' });
  await r.feed(0, { captureTs: 90000 });
  expect(r.factory).not.toHaveBeenCalled();
});
it('persistent reservation failure prevents arming or outputs', async () => {
  const r = rig();
  r.reserve.mockImplementationOnce(() => {
    throw new Error('disk');
  });
  await r.feed(0);
  expect(r.monitor.status().running).toBe(false);
  expect(r.factory).not.toHaveBeenCalled();
});
