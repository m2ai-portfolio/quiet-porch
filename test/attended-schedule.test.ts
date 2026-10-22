import { expect, it, vi } from 'vitest';
import { validateSchedule, waitForAttendedStart } from '../src/attended-schedule.ts';
import { createAttendedTest } from '../src/attended-test.ts';
const scope = { accountId: 'owner', deviceId: 'cam', zone: 'front_yard' };
function rig() {
  let time = 100000,
    mono = 0,
    permitted = true;
  const startsAt = 130000,
    expiresAt = 190000;
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const controller = createAttendedTest({
    scope,
    outputs,
    authorize: () => time >= startsAt && time < expiresAt && permitted,
    ready: async () => true,
    killed: () => false,
    audit: () => {},
    wall: () => time,
    mono: () => mono,
  });
  const preparation = {
    startsAt,
    expiresAt,
    signal: controller.signal,
    permitted: () => permitted,
    now: () => time,
    mono: () => mono,
    preflight: vi.fn(async () => true),
    waiting: vi.fn(),
    arm: vi.fn(async () => controller.arm()),
    sleep: async (ms: number) => {
      time += ms;
      mono += ms;
    },
  };
  return {
    controller,
    outputs,
    preparation,
    time: () => time,
    setTime: (t: number) => {
      mono += t - time;
      time = t;
    },
    revoke: () => {
      permitted = false;
    },
  };
}
it('waits disarmed with no outputs until the agreed clock time, then arms', async () => {
  const r = rig();
  r.preparation.waiting.mockImplementation(() => {
    expect(r.controller.status().state).toBe('disarmed');
    expect(r.outputs.alert).not.toHaveBeenCalled();
    expect(r.outputs.speak).not.toHaveBeenCalled();
  });
  const sleep = r.preparation.sleep;
  r.preparation.sleep = async (ms) => {
    expect(r.controller.status().state).toBe('disarmed');
    expect(r.preparation.arm).not.toHaveBeenCalled();
    await sleep(ms);
  };
  try {
    await waitForAttendedStart(r.preparation);
    expect(r.time()).toBe(130000);
    expect(r.controller.status().state).toBe('armed');
    expect(r.preparation.preflight).toHaveBeenCalledTimes(2);
    expect(r.outputs.alert).not.toHaveBeenCalled();
  } finally {
    await r.controller.disarm();
  }
});
it('cancellation while waiting never arms or dispatches', async () => {
  const r = rig();
  r.preparation.sleep = async () => {
    await r.controller.disarm('cancel_wait');
  };
  await expect(waitForAttendedStart(r.preparation)).rejects.toThrow('preparation_cancelled');
  expect(r.preparation.arm).not.toHaveBeenCalled();
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
});
it('authority loss while waiting cancels before arm', async () => {
  const r = rig();
  r.preparation.sleep = async () => r.revoke();
  await expect(waitForAttendedStart(r.preparation)).rejects.toThrow('preparation_cancelled');
  expect(r.preparation.arm).not.toHaveBeenCalled();
  await r.controller.disarm();
});
it('a delayed wake misses the agreed start and cannot extend the deadline', async () => {
  const r = rig();
  r.preparation.sleep = async () => r.setTime(133000);
  await expect(waitForAttendedStart(r.preparation)).rejects.toThrow('scheduled_start_missed');
  expect(r.preparation.arm).not.toHaveBeenCalled();
  await r.controller.disarm();
});
it('a slow async arm is rejected before any event processing; caller cleanup disarms', async () => {
  const r = rig();
  r.preparation.arm.mockImplementation(async () => {
    await r.controller.arm();
    r.setTime(133000);
  });
  try {
    await expect(waitForAttendedStart(r.preparation)).rejects.toThrow('scheduled_start_missed');
  } finally {
    await r.controller.disarm('schedule_failure');
  }
  expect(r.controller.status().state).toBe('ended');
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});
it('active timeout is fixed to scheduled time, independent of preparation duration', async () => {
  const r = rig();
  try {
    await waitForAttendedStart(r.preparation);
    r.setTime(190000);
    await r.controller.tick();
    expect(r.controller.status().state).toBe('ended');
    expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  } finally {
    await r.controller.disarm();
  }
});
it('readiness failure stops during disarmed preparation', async () => {
  const r = rig();
  r.preparation.preflight.mockResolvedValueOnce(false);
  await expect(waitForAttendedStart(r.preparation)).rejects.toThrow('scheduled_preflight_failed');
  expect(r.preparation.arm).not.toHaveBeenCalled();
  await r.controller.disarm();
});
it('clock jumps cancel rather than moving the active window', async () => {
  const r = rig();
  let offset = 0;
  r.preparation.now = () => r.time() + offset;
  r.preparation.sleep = async () => {
    offset = 5000;
  };
  await expect(waitForAttendedStart(r.preparation)).rejects.toThrow(
    'preparation_clock_changed_or_expired',
  );
  expect(r.preparation.arm).not.toHaveBeenCalled();
  await r.controller.disarm();
});
it.each([
  [100000, 160000],
  [110000, 170000],
  [500001, 560001],
  [130000, 200000],
])('rejects missing notice, unbounded waiting or extended expiry %j', (start, end) => {
  expect(() => validateSchedule(start, end, 100000)).toThrow('invalid_scheduled_window');
});
