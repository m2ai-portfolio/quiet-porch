import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAttendedTest, type TestEvidence } from '../src/attended-test.ts';
import { parsePipelineConfig } from '../src/pipeline.ts';
const scope = { accountId: 'owner', deviceId: 'cam', zone: 'front_yard' };
function rig() {
  let time = 100000,
    mono = 0,
    authorized = true,
    killed = false,
    auditBroken = false;
  const rows: Record<string, unknown>[] = [];
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const t = createAttendedTest({
    scope,
    outputs,
    authorize: () => authorized,
    killed: () => killed,
    ready: async () => true,
    wall: () => time,
    mono: () => mono,
    audit: (row) => {
      if (auditBroken) throw new Error('disk_full');
      rows.push(row);
    },
  });
  const advance = (s: number) => {
    time = 100000 + s * 1000;
    mono = s * 1000;
  };
  const ev = (s: number, patch: Partial<TestEvidence> = {}): TestEvidence => ({
    ...scope,
    id: `e${s}`,
    captureTs: 100000 + s * 1000,
    source: 'ring',
    verdict: 'person',
    ...patch,
  });
  const frame = async (s: number, patch: Partial<TestEvidence> = {}) => {
    advance(s);
    await t.feed(ev(s, patch));
  };
  return {
    t,
    outputs,
    rows,
    ev,
    advance,
    frame,
    revoke: () => {
      authorized = false;
    },
    kill: () => {
      killed = true;
    },
    breakAudit: () => {
      auditBroken = true;
    },
  };
}
const sessions: ReturnType<typeof rig>[] = [];
function make() {
  const r = rig();
  sessions.push(r);
  return r;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((r) => r.t.disarm()));
  vi.useRealTimers();
});
describe('bounded attended encounter, mocked outputs only', () => {
  it('defaults disarmed and ignores evidence', async () => {
    const r = make();
    await r.frame(0);
    expect(r.outputs.alert).not.toHaveBeenCalled();
    expect(r.t.status().state).toBe('disarmed');
  });
  it('runs start/10s single alert/20s speech/40s hold/departure with an ordered audit trail', async () => {
    const r = make();
    await r.t.arm();
    for (let s = 0; s <= 45; s += 5) await r.frame(s);
    expect(r.outputs.alert).toHaveBeenCalledTimes(1);
    expect(r.outputs.speak).toHaveBeenCalledTimes(1);
    expect(r.rows.filter((x) => x.event === 'hold_no_additional_outputs')).toHaveLength(1);
    await r.frame(46, { verdict: 'empty' });
    expect(r.t.status().state).toBe('ended');
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
    expect(r.rows.findIndex((x) => x.event === 'alert_intent')).toBeLessThan(
      r.rows.findIndex((x) => x.event === 'alert_ack'),
    );
    await expect(r.t.arm()).rejects.toThrow('one_shot');
  });
  it.each(['accountId', 'deviceId', 'zone'] as const)('rejects wrong %s', async (key) => {
    const r = make();
    await r.t.arm();
    await r.frame(0, { [key]: 'other' });
    expect(r.rows.some((x) => x.event === 'encounter_started')).toBe(false);
  });
  it.each([
    { captureTs: NaN },
    { captureTs: 90000 },
    { captureTs: 100001 },
    { source: 'synthetic' as 'ring' },
  ])('rejects invalid or untrusted evidence %j', async (patch) => {
    const r = make();
    await r.t.arm();
    await r.frame(0, patch);
    expect(r.rows.some((x) => x.event === 'encounter_started')).toBe(false);
  });
  it('never turns a replay or duplicate into elapsed dwell', async () => {
    const r = make();
    await r.t.arm();
    await r.frame(0);
    await r.frame(5, { id: 'e0' });
    expect(r.outputs.alert).not.toHaveBeenCalled();
    r.advance(6);
    await r.t.tick();
    expect(r.t.status().state).toBe('ended');
  });
  it('stops on missing evidence independently of new input', async () => {
    const r = make();
    await r.t.arm();
    await r.frame(0);
    r.advance(6);
    await r.t.tick();
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  });
  it('expires an unused session at 60 seconds', async () => {
    const r = make();
    await r.t.arm();
    r.advance(60);
    await r.t.tick();
    expect(r.t.status().state).toBe('ended');
  });
  it.each(['kill', 'revoke'] as const)('stops on %s', async (method) => {
    const r = make();
    await r.t.arm();
    r[method]();
    await r.t.tick();
    expect(r.t.status().state).toBe('ended');
  });
  it('disarm stops an in-flight alert and prevents subsequent speech', async () => {
    const r = make();
    let finish!: () => void;
    r.outputs.alert.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await r.t.arm();
    await r.frame(0);
    await r.frame(5);
    const pending = r.frame(10);
    await Promise.resolve();
    await r.t.disarm();
    finish();
    await pending;
    await r.frame(20);
    expect(r.outputs.speak).not.toHaveBeenCalled();
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  });
  it('ambiguous alert failure is not retried or followed by speech', async () => {
    const r = make();
    r.outputs.alert.mockRejectedValueOnce(new Error('network'));
    await r.t.arm();
    await r.frame(0);
    await r.frame(5);
    await r.frame(10);
    await r.frame(15);
    expect(r.outputs.alert).toHaveBeenCalledTimes(1);
    expect(r.outputs.speak).not.toHaveBeenCalled();
    expect(r.t.status().state).toBe('ended');
  });
  it('speech failure stops and does not repeat', async () => {
    const r = make();
    r.outputs.speak.mockRejectedValueOnce(new Error('ssh'));
    await r.t.arm();
    for (let s = 0; s <= 25; s += 5) await r.frame(s);
    expect(r.outputs.speak).toHaveBeenCalledTimes(1);
    expect(r.t.status().state).toBe('ended');
  });
  it('audit failure prevents dispatch but cannot prevent stop', async () => {
    const r = make();
    await r.t.arm();
    r.breakAudit();
    await r.frame(0);
    expect(r.outputs.alert).not.toHaveBeenCalled();
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  });
  it('uncertain evidence terminates rather than escalating', async () => {
    const r = make();
    await r.t.arm();
    await r.frame(0, { verdict: 'uncertain' });
    expect(r.t.status().state).toBe('ended');
  });
  it('retains the production dry-run parser lock', () => {
    expect(() => parsePipelineConfig({ dryRun: false })).toThrow('dryRun must be true');
  });
});

it('an output deadline aborts and cleans up without retry', async () => {
  vi.useFakeTimers();
  const r = make();
  r.outputs.alert.mockImplementationOnce(() => new Promise<void>(() => {}));
  await r.t.arm();
  await r.frame(0);
  await r.frame(5);
  const pending = r.frame(10);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(3000);
  await pending;
  expect(r.t.status().state).toBe('ended');
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).not.toHaveBeenCalled();
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});

it('cannot arm after being disarmed during readiness checks', async () => {
  let complete!: (r: boolean) => void;
  const stop = vi.fn(async () => {});
  const t = createAttendedTest({
    scope,
    authorize: () => true,
    killed: () => false,
    ready: () =>
      new Promise<boolean>((r) => {
        complete = r;
      }),
    audit: () => {},
    outputs: { alert: async () => {}, speak: async () => {}, stop },
  });
  const pending = t.arm();
  await t.disarm();
  complete(true);
  await expect(pending).rejects.toThrow('not_ready');
  expect(t.status().state).toBe('ended');
  expect(stop).toHaveBeenCalledTimes(1);
});

it('cleanup failure is recorded and never restores armed state', async () => {
  const r = make();
  r.outputs.stop.mockRejectedValueOnce(new Error('unreachable'));
  await r.t.arm();
  await r.t.disarm();
  expect(r.rows.some((x) => x.event === 'cleanup_failed')).toBe(true);
  expect(r.t.status().cleanupSucceeded).toBe(false);
  expect(r.t.status().state).toBe('ended');
  await expect(r.t.arm()).rejects.toThrow('one_shot');
});

it('a fresh receipt cannot hide a gap between capture timestamps', async () => {
  const r = make();
  await r.t.arm();
  r.advance(5);
  await r.t.feed(r.ev(0)); // valid five-second-old first frame
  r.advance(10);
  await r.t.feed(r.ev(10)); // receipt gap 5s, capture gap 10s
  expect(r.t.status().endReason).toBe('capture_gap');
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.t.status().cleanupSucceeded).toBe(true);
});
