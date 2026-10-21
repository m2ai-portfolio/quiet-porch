import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSpeakerOutput, speakerReadinessCommand } from '../src/speaker-output.ts';
import { createAttendedTest } from '../src/attended-test.ts';

const clip = `speech-${'a'.repeat(64)}`;
const fingerprint = '12b20969fc2c';
const healthy = {
  speakerFingerprint: fingerprint,
  virtual: false,
  volume: 1,
  idle: true,
  boundedHelper: true,
  clipPresent: true,
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
  let dispatchError: Error | undefined;
  let acknowledgement = true;
  const rows: Record<string, unknown>[] = [];
  const dispatchTimes: number[] = [];
  const ssh = vi.fn(async (command: string, signal?: AbortSignal) => {
    if (command.startsWith('python3 -c ')) {
      time += delay;
      afterReadiness();
      if (signal?.aborted) throw new DOMException(privateText, 'AbortError');
      return JSON.stringify(snapshot);
    }
    if (command.startsWith('qp-speak ')) {
      dispatchTimes.push(time);
      time += 200;
      if (dispatchError) throw dispatchError;
      return acknowledgement ? `started qp-audio-${command.split(' ')[1]}` : privateText;
    }
    if (command.startsWith('qp-stop ')) return 'stopped';
    if (command === 'qp-status') return 'idle';
    throw new Error('unexpected command');
  });
  const speaker = createSpeakerOutput({
    ssh,
    speakerFingerprint: fingerprint,
    clip,
    audit: (row) => rows.push(row),
    authorized: () => authority,
    killed: () => killed,
    now: () => time,
    mono: () => time,
  });
  const outputs = speaker.outputs();
  return {
    speaker,
    outputs,
    ssh,
    rows,
    dispatchTimes,
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

it.each([
  [{ speakerFingerprint: 'other' }, 'sink'],
  [{ virtual: true }, 'sink'],
  [{ volume: 1.01 }, 'volume'],
  [{ volume: 0 }, 'volume'],
  [{ volume: null }, 'volume'],
  [{ idle: false }, 'status'],
  [{ boundedHelper: false }, 'helper'],
  [{ clipPresent: false }, 'clip'],
  [{ failedCheck: 'status', exitCode: 3 }, 'status'],
  [{ failedCheck: privateText, exitCode: privateText }, 'protocol'],
] as const)('rejects unavailable readiness without dispatch: %j', async (patch, reason) => {
  const r = rig();
  r.snapshot({ ...healthy, ...patch });
  await expect(
    r.outputs.speak('fixture', new AbortController().signal, () => true),
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
  expect(r.dispatchTimes).toEqual([capture + 5534]);
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
  const r = await encounter(delay);
  await r.feed(21000);
  expect(r.dispatchTimes).toEqual([]);
  expect(r.t.status()).toMatchObject({ state: 'ended', endReason: 'failure' });
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'speech_output_failed', stage: 'freshness' }),
  );
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'output_failed', output: 'speak' }),
  );
  expect(r.rows.some((row) => row.event === 'speak_ack')).toBe(false);
});

it.each(['cancel', 'authority', 'emergency_disarm'] as const)(
  'rejects %s during readiness',
  async (condition) => {
    const r = rig();
    const abort = new AbortController();
    r.onReadiness(
      condition === 'cancel' ? () => abort.abort() : condition === 'authority' ? r.revoke : r.kill,
    );
    await expect(r.outputs.speak('fixture', abort.signal, () => true)).rejects.toThrow();
    expect(r.dispatchTimes).toEqual([]);
    expect(r.rows).toContainEqual(
      expect.objectContaining({
        event: 'speech_output_failed',
        stage: condition === 'cancel' ? 'readiness' : condition,
      }),
    );
  },
);

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
  r.ssh.mockResolvedValueOnce(privateText);
  await expect(
    r.outputs.speak('fixture', new AbortController().signal, () => true),
  ).rejects.toThrow();
  expect(r.rows).toContainEqual(
    expect.objectContaining({ event: 'speaker_readiness_failed', error_class: 'SyntaxError' }),
  );
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
    writeFileSync(join(dir, 'qp-speak'), '#!/bin/sh\n# -p RuntimeMaxSec=4\nexit 99\n', {
      mode: 0o755,
    });
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
    });
    writeFileSync(join(dir, 'qp-status'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    expect(await run()).toEqual({ failedCheck: 'status', exitCode: 7 });
    expect(() => speakerReadinessCommand('evil; touch /tmp/unwanted')).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
