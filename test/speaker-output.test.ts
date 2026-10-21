import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSpeakerOutput, speakerReadinessCommand } from '../src/speaker-output.ts';
import { createAttendedTest } from '../src/attended-test.ts';
import { createActionGuard } from '../src/action-guard.ts';

const clip = `speech-${'a'.repeat(64)}`;
const fingerprint = '12b20969fc2c';
const healthy = {
  speakerFingerprint: fingerprint,
  virtual: false,
  volume: 1,
  idle: true,
  boundedHelper: true,
  clipPresent: true,
  bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  piMonotonicMs: 50000,
};
const privateText = 'SECRET https://private.invalid/frame?token=SECRET';
const sessions: ReturnType<typeof createAttendedTest>[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.disarm()));
  vi.useRealTimers();
});

function rig(delay = 250) {
  let time = 100000;
  let snapshot: unknown = healthy;
  let authority = true,
    killed = false;
  let afterReadiness = () => {};
  let afterPrepared = () => {};
  let dispatchError: Error | undefined;
  let acknowledgement = true;
  const rows: Record<string, unknown>[] = [];
  const dispatchTimes: number[] = [];
  const dispatchDeadlines: number[] = [];
  const ssh = vi.fn(async (command: string, signal?: AbortSignal) => {
    if (command.startsWith('python3 -c ')) {
      time += delay;
      afterReadiness();
      if (signal?.aborted) throw new DOMException(privateText, 'AbortError');
      return JSON.stringify(snapshot);
    }
    if (command.startsWith('qp-speak-guarded dispatch ')) {
      dispatchTimes.push(time);
      dispatchDeadlines.push(Number(command.split(' ').at(-1)));
      time += 200;
      if (dispatchError) throw dispatchError;
      return acknowledgement ? `accepted qp-audio-${command.split(' ')[2]}` : privateText;
    }
    if (command.startsWith('qp-stop ')) return 'stopped';
    if (command === 'qp-status') return 'idle';
    throw new Error('unexpected command');
  });
  const speaker = createSpeakerOutput({
    ssh,
    speakerFingerprint: fingerprint,
    clip,
    audit: (row) => {
      rows.push(row);
      // Models local work between the prepared record and the final freshness check.
      if (row.event === 'speech_prepared') afterPrepared();
    },
    authorized: () => authority,
    killed: () => killed,
    now: () => time,
    mono: () => time,
  });
  const outputs = speaker.outputs();
  const readinessCalls = () => ssh.mock.calls.filter(([c]) => c.startsWith('python3 -c ')).length;
  return {
    guard: () =>
      createActionGuard({
        captureTs: time,
        wall: () => time,
        mono: () => time,
        unsafeReason: () => undefined,
      }),
    speaker,
    outputs,
    ssh,
    rows,
    dispatchTimes,
    dispatchDeadlines,
    readinessCalls,
    now: () => time,
    setTime: (next: number) => {
      time = next;
    },
    snapshot: (next: unknown) => {
      snapshot = next;
    },
    onReadiness: (fn: () => void) => {
      afterReadiness = fn;
    },
    onPrepared: (fn: () => void) => {
      afterPrepared = fn;
    },
    revoke: () => {
      authority = false;
    },
    kill: () => {
      killed = true;
    },
    failDispatch: () => {
      dispatchError = Object.assign(new Error(privateText), { code: 255 });
    },
    badAck: () => {
      acknowledgement = false;
    },
  };
}

it('uses one read-only round trip for all checks; preflight never dispatches or plays', async () => {
  const r = rig();
  expect(await r.speaker.ready()).toBe(true);
  expect(r.ssh).toHaveBeenCalledTimes(1);
  expect(r.dispatchTimes).toEqual([]);
  expect(r.rows.at(-1)).toMatchObject({ ready: true, elapsed_ms: 250 });
});

it('transfers the shorter one-shot authority deadline so delayed remote launch is refused', async () => {
  let time = 100000;
  let remotePlayCount = 0;
  const expires = time + 1000;
  const ssh = vi.fn(async (command: string) => {
    if (command.startsWith('python3 -c ')) {
      time += 250;
      return JSON.stringify(healthy);
    }
    if (command.startsWith('qp-speak-guarded dispatch ')) {
      const deadline = Number(command.split(' ').at(-1));
      // Admitted 250 ms after the Pi sample; 750 ms of authority remain at dispatch.
      expect(deadline).toBe(healthy.piMonotonicMs + 750);
      time += 800;
      // Model the unchanged Pi helper's final check after remote queuing.
      if (healthy.piMonotonicMs + 800 >= deadline) return 'refused_expired';
      remotePlayCount++;
      return 'accepted qp-audio-fixture';
    }
    if (command.startsWith('qp-stop ')) return 'stopped';
    if (command === 'qp-status') return 'idle';
    throw new Error('unexpected command');
  });
  const speaker = createSpeakerOutput({
    ssh,
    speakerFingerprint: fingerprint,
    clip,
    authorized: () => time < expires,
    authorityRemainingMs: () => expires - time,
    killed: () => false,
    audit: () => {},
    now: () => time,
    mono: () => time,
  });
  expect(await speaker.ready()).toBe(true);
  const outputs = speaker.outputs();
  const guard = createActionGuard({
    captureTs: time,
    wall: () => time,
    mono: () => time,
    unsafeReason: () => undefined,
  });
  await expect(
    outputs.speak('fixture', new AbortController().signal, () => true, guard),
  ).rejects.toThrow();
  await outputs.stop();
  expect(remotePlayCount).toBe(0);
  expect(ssh.mock.calls.filter(([c]) => c.startsWith('qp-speak-guarded dispatch '))).toHaveLength(
    1,
  );
});

it.each([0, -1, NaN, Infinity])(
  'refuses invalid remaining authority %s before dispatch',
  async (remaining) => {
    const ssh = vi.fn(async () => JSON.stringify(healthy));
    const speaker = createSpeakerOutput({
      ssh,
      speakerFingerprint: fingerprint,
      clip,
      authorized: () => true,
      authorityRemainingMs: () => remaining,
      killed: () => false,
      audit: () => {},
    });
    const guard = createActionGuard({
      captureTs: Date.now(),
      wall: Date.now,
      mono: () => performance.now(),
      unsafeReason: () => undefined,
    });
    expect(await speaker.ready()).toBe(true);
    await expect(
      speaker.outputs().speak('fixture', new AbortController().signal, () => true, guard),
    ).rejects.toThrow();
    expect(ssh).toHaveBeenCalledTimes(1);
  },
);

it('refuses to speak before any admission inspect, without a round trip', async () => {
  const r = rig();
  await expect(
    r.outputs.speak('fixture', new AbortController().signal, () => true, r.guard()),
  ).rejects.toThrow('audio_not_ready');
  expect(r.ssh).not.toHaveBeenCalled();
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'speech_output_failed', stage: 'readiness' }),
  );
});

it('dispatches on the admission snapshot alone and projects the Pi deadline by elapsed time', async () => {
  const r = rig();
  expect(await r.speaker.ready()).toBe(true); // Pi sample 50000 received at 100250.
  r.setTime(r.now() + 20000);
  await r.outputs.speak('fixture', new AbortController().signal, () => true, r.guard());
  expect(r.readinessCalls()).toBe(1);
  expect(r.dispatchTimes).toEqual([120250]);
  // 50000 + 20000 elapsed since receipt + 6000 fresh: never later than the Pi's own clock.
  expect(r.dispatchDeadlines).toEqual([healthy.piMonotonicMs + 20000 + 6000]);
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'speech_prepared', snapshot_age_ms: 20000 }),
  );
  expect(r.rows).toContainEqual(expect.objectContaining({ event: 'speech_dispatch_acknowledged' }));
});

it('a later inspect that is not ready clears the admission and blocks dispatch', async () => {
  const r = rig();
  expect(await r.speaker.ready()).toBe(true);
  r.snapshot({ ...healthy, idle: false });
  expect(await r.speaker.ready()).toBe(false);
  await expect(
    r.outputs.speak('fixture', new AbortController().signal, () => true, r.guard()),
  ).rejects.toThrow('audio_not_ready');
  expect(r.dispatchTimes).toEqual([]);
});

it.each([
  [{ speakerFingerprint: 'other' }, 'sink'],
  [{ virtual: true }, 'sink'],
  [{ volume: 1.01 }, 'volume'],
  [{ volume: 0 }, 'volume'],
  [{ volume: 0.36 }, 'volume'],
  [{ bootId: 'invalid' }, 'clock'],
  [{ piMonotonicMs: -1 }, 'clock'],
  [{ volume: null }, 'volume'],
  [{ idle: false }, 'status'],
  [{ boundedHelper: false }, 'helper'],
  [{ clipPresent: false }, 'clip'],
  [{ failedCheck: 'status', exitCode: 3 }, 'status'],
  [{ failedCheck: privateText, exitCode: privateText }, 'protocol'],
] as const)('rejects unavailable readiness without dispatch: %j', async (patch, reason) => {
  const r = rig();
  r.snapshot({ ...healthy, ...patch });
  expect(await r.speaker.ready()).toBe(false);
  await expect(
    r.outputs.speak('fixture', new AbortController().signal, () => true, r.guard()),
  ).rejects.toThrow();
  expect(r.dispatchTimes).toEqual([]);
  expect(r.rows).toContainEqual(expect.objectContaining({ rejected_check: reason, ready: false }));
  expect(JSON.stringify(r.rows)).not.toContain(privateText);
});

it('keeps other speakers at 60% even through the batched readiness path', async () => {
  const ssh = vi.fn(async () =>
    JSON.stringify({ ...healthy, speakerFingerprint: 'other', volume: 1 }),
  );
  const speaker = createSpeakerOutput({
    ssh,
    speakerFingerprint: 'other',
    clip,
    authorized: () => true,
    killed: () => false,
    audit: () => {},
  });
  expect(await speaker.ready()).toBe(false);
  ssh.mockResolvedValue(JSON.stringify({ ...healthy, speakerFingerprint: 'other', volume: 0.6 }));
  expect(await speaker.ready()).toBe(true);
});

async function encounter(delay: number) {
  vi.useFakeTimers();
  const r = rig(delay);
  // Exercise startup preflight, encounter arm, then real capture-time dwell (mocked camera).
  expect(await r.speaker.ready()).toBe(true);
  const alert = vi.fn(async () => {});
  const scope = { accountId: 'fixture-owner', deviceId: 'fixture-camera', zone: 'front_yard' };
  const t = createAttendedTest({
    scope,
    outputs: { ...r.outputs, alert },
    ready: () => r.speaker.ready(),
    authorize: () => true,
    killed: () => false,
    wall: r.now,
    mono: r.now,
    audit: (row) => r.rows.push(row),
  });
  sessions.push(t);
  await t.arm();
  const first = r.now();
  const feed = async (dwell: number, verdict: 'person' | 'empty' = 'person') => {
    const capture = first + dwell;
    r.setTime(capture + 5284); // Same analysis age as the real speech-intent frame.
    await t.feed({ ...scope, source: 'ring', verdict, id: `frame-${dwell}`, captureTs: capture });
    return capture;
  };
  for (let dwell = 0; dwell < 21000; dwell += 3500) await feed(dwell);
  return { ...r, t, alert, feed };
}

it('preflight-to-dispatch succeeds within 6s, caps outputs and stops on departure', async () => {
  const r = await encounter(250);
  const capture = await r.feed(21000);
  // Dispatch leaves at the analysis age itself: no readiness round trip precedes it.
  expect(r.dispatchTimes).toEqual([capture + 5284]);
  expect(r.readinessCalls()).toBe(2); // startup preflight and encounter arm only
  expect(r.alert).toHaveBeenCalledTimes(1);
  expect(r.rows).toContainEqual(expect.objectContaining({ event: 'speak_ack' }));
  await r.feed(24500);
  expect(r.dispatchTimes).toHaveLength(1);
  await r.feed(28000, 'empty');
  expect(r.t.status()).toMatchObject({
    state: 'ended',
    endReason: 'departure',
    cleanupSucceeded: true,
  });
  expect(r.ssh.mock.calls.filter(([c]) => c.startsWith('qp-stop '))).toHaveLength(1);
});

it.each([716, 1360])('still refuses dispatch when preparation takes %i ms', async (delay) => {
  const r = await encounter(250);
  r.onPrepared(() => r.setTime(r.now() + delay));
  await r.feed(21000);
  expect(r.dispatchTimes).toEqual([]);
  expect(r.t.status()).toMatchObject({ state: 'ended', endReason: 'action_evidence_expired' });
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'speech_output_failed', stage: 'freshness' }),
  );
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'output_failed', output: 'speak' }),
  );
  expect(r.rows.some((row) => row.event === 'speak_ack')).toBe(false);
});

it.each(['cancel', 'authority', 'emergency_disarm'] as const)(
  'rejects %s after admission, before dispatch',
  async (condition) => {
    const r = rig();
    const abort = new AbortController();
    expect(await r.speaker.ready()).toBe(true);
    (condition === 'cancel'
      ? () => abort.abort()
      : condition === 'authority'
        ? r.revoke
        : r.kill)();
    await expect(r.outputs.speak('fixture', abort.signal, () => true, r.guard())).rejects.toThrow();
    expect(r.dispatchTimes).toEqual([]);
    expect(r.readinessCalls()).toBe(1);
    expect(r.rows).toContainEqual(
      expect.objectContaining({
        event: 'speech_output_failed',
        stage: condition === 'cancel' ? 'cancelled' : condition,
      }),
    );
  },
);

it('cancellation during the admission inspect is recorded without leaking', async () => {
  const r = rig();
  const abort = new AbortController();
  r.onReadiness(() => abort.abort());
  await expect(r.speaker.ready(abort.signal)).rejects.toThrow();
  expect(r.rows).toContainEqual(expect.objectContaining({ event: 'speaker_readiness_failed' }));
  expect(JSON.stringify(r.rows)).not.toContain(privateText);
});

it.each(['dispatch', 'acknowledgement'] as const)(
  'records %s failure, cleans up and never retries',
  async (stage) => {
    const r = await encounter(250);
    if (stage === 'dispatch') r.failDispatch();
    else r.badAck();
    await r.feed(21000);
    await r.feed(24500);
    expect(r.dispatchTimes).toHaveLength(1);
    expect(r.t.status()).toMatchObject({ state: 'ended', cleanupSucceeded: true });
    expect(r.ssh.mock.calls.filter(([c]) => c.startsWith('qp-stop '))).toHaveLength(1);
    expect(r.rows).toContainEqual(
      expect.objectContaining({ event: 'speech_output_failed', stage }),
    );
    if (stage === 'dispatch')
      expect(r.rows).toContainEqual(
        expect.objectContaining({ event: 'output_failed', exit_code: 255 }),
      );
    expect(JSON.stringify(r.rows)).not.toMatch(/SECRET|private\.invalid/);
  },
);

it('records malformed readiness and transport errors without leaking their content', async () => {
  const r = rig();
  expect(await r.speaker.ready()).toBe(true);
  r.ssh.mockResolvedValueOnce(privateText);
  await expect(r.speaker.ready()).rejects.toThrow();
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'speaker_readiness_failed', error_class: 'SyntaxError' }),
  );
  // A failed re-inspect clears the earlier admission: nothing dispatches on it.
  await expect(
    r.outputs.speak('fixture', new AbortController().signal, () => true, r.guard()),
  ).rejects.toThrow('audio_not_ready');
  expect(r.dispatchTimes).toEqual([]);
  r.ssh.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 255 }));
  await expect(r.speaker.ready()).rejects.toThrow();
  expect(JSON.stringify(r.rows)).not.toMatch(/SECRET|private\.invalid/);
});

it('executes the generated read-only batch against offline command fixtures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-readiness-'));
  const address = '11:22:33:44:55:66';
  try {
    mkdirSync(join(dir, 'quiet-porch/clips'), { recursive: true });
    writeFileSync(join(dir, 'quiet-porch/clips', `${clip}.wav`), 'fixture');
    // Redirect only the fixture interpreter's Path.home(), never the host's HOME.
    writeFileSync(
      join(dir, 'python3'),
      `#!/usr/bin/python3\nfrom pathlib import Path\nimport sys\nPath.home=staticmethod(lambda: Path(${JSON.stringify(dir)}))\nscript=sys.argv[2]\nsys.argv=sys.argv[1:2]+sys.argv[3:]\nexec(script)\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, 'wpctl'),
      '#!/bin/sh\nif [ "$1" = inspect ]; then echo \'  node.name = "bluez_output.11_22_33_44_55_66"\'; else echo "Volume: 0.60"; fi\n',
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'qp-status'), '#!/bin/sh\necho idle\n', { mode: 0o755 });
    writeFileSync(
      join(dir, 'qp-speak-guarded'),
      '#!/bin/sh\n# RuntimeMaxSec=4 QUIET_PORCH_GUARDED_SPEECH_V1\nexit 99\n',
      {
        mode: 0o755,
      },
    );
    const run = async () =>
      JSON.parse(
        (
          await promisify(execFile)('bash', ['-c', speakerReadinessCommand(clip)], {
            env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
            encoding: 'utf8',
          })
        ).stdout,
      );
    expect(await run()).toEqual({
      ...healthy,
      volume: 0.6,
      speakerFingerprint: createHash('sha256').update(address).digest('hex').slice(0, 12),
      bootId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      piMonotonicMs: expect.any(Number),
    });
    writeFileSync(join(dir, 'qp-status'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    expect(await run()).toEqual({ failedCheck: 'status', exitCode: 7 });
    expect(() => speakerReadinessCommand('evil; touch /tmp/unwanted')).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('readiness honours a required office level exactly and nothing else', async () => {
  const ready = async (volume: number, requiredVolume?: number) =>
    createSpeakerOutput({
      ssh: async () => JSON.stringify({ ...healthy, volume }),
      speakerFingerprint: fingerprint,
      requiredVolume,
      clip,
      audit: () => {},
      authorized: () => true,
      killed: () => false,
    }).ready();
  expect(await ready(0.36, 0.36)).toBe(true);
  expect(await ready(1, 0.36)).toBe(false);
  expect(await ready(0.51, 0.36)).toBe(false);
  expect(await ready(0.36)).toBe(false);
  expect(await ready(1)).toBe(true);
});
