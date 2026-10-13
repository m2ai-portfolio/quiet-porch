// QP-08 decoder transport and QP-09 capture-time provenance. Synthetic inputs only: a fake
// child process for lifecycle edges, and the real GStreamer helper on a videotestsrc (no camera,
// no network) to prove the actual decode path. Live Ring capture remains a hardware gate (QP-10).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDecoderTransport,
  createFrameParser,
  DECODER_KILL_GRACE_MS,
  gstDecoderCommand,
  type SpawnFn,
} from '../src/live-decoder.ts';
import {
  deriveCaptureTime,
  LIVE_CAPTURE_NO_GO,
  referenceToUnixMs,
  type CapturePolicy,
} from '../src/capture-time.ts';
import { createLiveSource } from '../src/live-source.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const NTP_OFFSET_NS = 2_208_988_800_000_000_000n;
const ntpNs = (unixMs: number) => BigInt(unixMs) * 1_000_000n + NTP_OFFSET_NS;

function record(header: object, jpeg = JPEG) {
  const h = Buffer.from(JSON.stringify(header));
  const lens = Buffer.alloc(8);
  lens.writeUInt32BE(h.length, 0);
  lens.writeUInt32BE(jpeg.length, 4);
  return Buffer.concat([Buffer.from('QPF1'), lens.subarray(0, 4), h, lens.subarray(4), jpeg]);
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills: string[] = [];
  ignoreTerm = false;
  written = '';
  constructor() {
    super();
    this.stdin.on('data', (c) => (this.written += c.toString()));
    queueMicrotask(() => this.emit('spawn'));
  }
  kill(sig: string) {
    this.kills.push(sig);
    if (sig === 'SIGTERM' && this.ignoreTerm) return true;
    this.exit(null, sig);
    return true;
  }
  exit(code: number | null, sig: string | null = null) {
    this.exitCode = code;
    this.signalCode = sig;
    this.emit('exit', code, sig);
  }
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: { file: string; args: string[] }[] = [];
  const spawn = ((file: string, args: string[]) => {
    calls.push({ file, args });
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  }) as SpawnFn;
  return { spawn, children, calls };
}

const TRUST: CapturePolicy = {
  trustStreamReference: true,
  trustedClocks: ['timestamp/x-ntp'],
  maxReceiptLagMs: 2000,
  maxFutureSkewMs: 250,
};

afterEach(() => vi.useRealTimers());

describe('decoder frame parser', () => {
  it('reassembles records split at every byte and keeps 64-bit nanoseconds exact', () => {
    const ts = '3969100800123456789'; // past 2^53: would be corrupted as a JSON number
    const bytes = Buffer.concat([
      record({ pts_ns: '1', ref: { clock: 'timestamp/x-ntp', ts_ns: ts } }),
      record({ pts_ns: null, ref: null }),
    ]);
    const p = createFrameParser();
    const out = [...bytes].flatMap((b) => p.push(Buffer.from([b])));
    expect(out).toHaveLength(2);
    expect(out[0].reference?.timestampNs).toBe(BigInt(ts));
    expect(out[0].jpeg.equals(JPEG)).toBe(true);
    expect(out[1]).toMatchObject({ ptsNs: null, reference: null });
  });
  it.each([
    ['bad magic', Buffer.from('XXXX\0\0\0\0')],
    ['oversized header', Buffer.concat([Buffer.from('QPF1'), Buffer.from([0, 0, 0x20, 0])])],
  ])('rejects %s instead of resynchronising', (_name, bytes) => {
    expect(() => createFrameParser().push(bytes)).toThrow(/decoder_/);
  });
});

describe('capture-time provenance (QP-09)', () => {
  const receivedAt = 1_760_000_000_000;
  const sample = (refMs: number | null, clock = 'timestamp/x-ntp') => ({
    ptsNs: 5n,
    reference: refMs === null ? null : { clock, timestampNs: ntpNs(refMs) },
    receivedAt,
  });
  it('the shipped policy is a no-go: even a plausible reference stays arrival', () => {
    const t = deriveCaptureTime(sample(receivedAt - 300), LIVE_CAPTURE_NO_GO);
    expect(t).toEqual({
      authority: 'arrival',
      captureTs: receivedAt,
      reason: 'reference_not_trusted',
    });
  });
  it.each([
    ['uncertain: no reference (PTS alone)', sample(null), 'no_reference_timestamp'],
    [
      'uncertain: untrusted clock',
      sample(receivedAt - 300, 'timestamp/x-ptp'),
      'untrusted_reference_clock',
    ],
    ['stale: lag beyond bound', sample(receivedAt - 2500), 'reference_lag_exceeds_bound'],
    ['future: ahead of receipt', sample(receivedAt + 1000), 'future_reference'],
  ])('rejects %s', (_name, s, reason) => {
    const t = deriveCaptureTime(s, TRUST);
    expect(t.authority).toBe('arrival');
    expect(t).toMatchObject({ reason, captureTs: receivedAt });
  });
  it('accepts a trusted NTP reference and never reports capture after receipt', () => {
    expect(deriveCaptureTime(sample(receivedAt - 300), TRUST)).toEqual({
      authority: 'ring',
      captureTs: receivedAt - 300,
    });
    expect(deriveCaptureTime(sample(receivedAt + 100), TRUST)).toEqual({
      authority: 'ring',
      captureTs: receivedAt,
    });
  });
  it('converts NTP and Unix reference epochs', () => {
    expect(referenceToUnixMs('timestamp/x-ntp', ntpNs(1234))).toBe(1234);
    expect(referenceToUnixMs('timestamp/x-unix', 1234_000_000n)).toBe(1234);
    expect(referenceToUnixMs('timestamp/x-other', 1n)).toBeUndefined();
  });
});

describe('decoder transport lifecycle (QP-08)', () => {
  it('starts the helper with the token on stdin only and delivers the newest frame', async () => {
    const f = fakeSpawn();
    let now = 10_000;
    const t = createDecoderTransport({
      command: (d) => gstDecoderCommand(d, '/helper.py'),
      token: () => 'secret-token',
      now: () => now,
      spawn: f.spawn,
    });
    const s = await t.open('acct', 'dev/1');
    const child = f.children[0];
    expect(f.calls[0].args).toEqual([
      '/helper.py',
      '--location',
      'rtsps://video.rtsp.amazonvision.com:322/v1/devices/dev%2F1/stream',
    ]);
    expect(f.calls[0].args.join(' ')).not.toContain('secret-token');
    await new Promise((r) => setImmediate(r));
    expect(child.written).toBe('secret-token\n');
    child.stdout.write(record({ pts_ns: '1', ref: null }, Buffer.from([0xff, 0xd8, 1])));
    child.stdout.write(record({ pts_ns: '2', ref: null }));
    await new Promise((r) => setImmediate(r));
    now = 10_050;
    const frame = await s.read();
    expect(frame).toMatchObject({
      accountId: 'acct',
      deviceId: 'dev/1',
      timestampAuthority: 'arrival',
    });
    expect(frame!.jpeg.equals(JPEG)).toBe(true); // older queued frame was dropped
    await s.close();
    expect(child.kills).toEqual(['SIGTERM']);
  });
  it('a read waits for the next frame', async () => {
    const f = fakeSpawn();
    const s = await createDecoderTransport({
      command: (d) => gstDecoderCommand(d, '/h'),
      token: () => 't',
      now: () => 1,
      spawn: f.spawn,
    }).open('a', 'd');
    const pending = s.read();
    f.children[0].stdout.write(record({ pts_ns: '1', ref: null }));
    expect((await pending)?.captureTs).toBe(1);
    await s.close();
  });
  it('reports a spawn error and a helper exit as errors, not as frames', async () => {
    const bad = createDecoderTransport({
      command: () => ({ file: 'x', args: [] }),
      token: () => 't',
      now: () => 1,
      spawn: (() => {
        const c = new EventEmitter() as unknown as ChildProcess;
        queueMicrotask(() => c.emit('error', new Error('ENOENT')));
        return c;
      }) as SpawnFn,
    });
    await expect(bad.open('a', 'd')).rejects.toThrow('ENOENT');

    const f = fakeSpawn();
    const s = await createDecoderTransport({
      command: (d) => gstDecoderCommand(d, '/h'),
      token: () => 't',
      now: () => 1,
      spawn: f.spawn,
    }).open('a', 'd');
    f.children[0].stderr.write('decoder_error unauthorized\n');
    f.children[0].exit(3);
    await expect(s.read()).rejects.toThrow('decoder_exited');
  });
  it('kills the helper on corrupt output', async () => {
    const f = fakeSpawn();
    const s = await createDecoderTransport({
      command: (d) => gstDecoderCommand(d, '/h'),
      token: () => 't',
      now: () => 1,
      spawn: f.spawn,
    }).open('a', 'd');
    f.children[0].stdout.write(Buffer.from('garbage!'));
    await expect(s.read()).rejects.toThrow('decoder_bad_magic');
    expect(f.children[0].kills).toEqual(['SIGTERM']);
  });
  const openFake = async (now = 1) => {
    const f = fakeSpawn();
    const s = await createDecoderTransport({
      command: (d) => gstDecoderCommand(d, '/h'),
      token: () => 't',
      now: () => now,
      policy: TRUST,
      spawn: f.spawn,
    }).open('a', 'd');
    return { s, child: f.children[0] };
  };
  const tick = () => new Promise((r) => setImmediate(r));
  // A frame the trusted policy grants ring authority: a fresh x-ntp reference 200 ms before now.
  const NOW = 1_760_000_000_000;
  const trustedRecord = () =>
    record({ pts_ns: '1', ref: { clock: 'timestamp/x-ntp', ts_ns: String(ntpNs(NOW - 200)) } });
  it('reverse state: with no helper failure, the queued trusted frame is delivered as ring', async () => {
    const { s, child } = await openFake(NOW);
    child.stdout.write(trustedRecord());
    await tick();
    const frame = await s.read();
    expect(frame?.timestampAuthority).toBe('ring');
    expect(frame?.captureTs).toBe(NOW - 200);
    await s.close();
  });
  it.each(['exit', 'corrupt'])(
    'a %s after a queued trusted frame invalidates it: read fails instead of delivering held evidence',
    async (kind) => {
      const { s, child } = await openFake(NOW);
      child.stdout.write(trustedRecord());
      await tick();
      if (kind === 'exit') child.exit(3);
      else child.stdout.write(Buffer.from('garbage!'));
      await tick();
      await expect(s.read()).rejects.toThrow(/decoder_/);
      await s.close();
    },
  );
  it('a token failure happens before spawn, so no helper is left waiting on stdin', async () => {
    const f = fakeSpawn();
    const t = createDecoderTransport({
      command: (d) => gstDecoderCommand(d, '/h'),
      token: () => {
        throw new Error('token_unavailable');
      },
      now: () => 1,
      spawn: f.spawn,
    });
    await expect(t.open('a', 'd')).rejects.toThrow('token_unavailable');
    expect(f.children).toHaveLength(0);
  });
  it('corrupt output from a helper that ignores SIGTERM is escalated to SIGKILL', async () => {
    vi.useFakeTimers();
    const { s, child } = await openFake();
    child.ignoreTerm = true;
    child.stdout.write(Buffer.from('garbage!'));
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(DECODER_KILL_GRACE_MS);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    await s.close(); // shares the same teardown; no extra signals
    expect(child.kills).toHaveLength(2);
  });
  it('close releases a pending read and escalates to SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const f = fakeSpawn();
    const s = await createDecoderTransport({
      command: (d) => gstDecoderCommand(d, '/h'),
      token: () => 't',
      now: () => 1,
      spawn: f.spawn,
    }).open('a', 'd');
    f.children[0].ignoreTerm = true;
    const pending = s.read();
    const closing = s.close();
    expect(await pending).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DECODER_KILL_GRACE_MS);
    await closing;
    expect(f.children[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    await s.close(); // idempotent once exited
    expect(f.children[0].kills).toHaveLength(2);
  });
});

describe('decoder transport inside createLiveSource', () => {
  async function run(policy?: CapturePolicy) {
    const f = fakeSpawn();
    const now = 1_760_000_000_000;
    const statuses: string[] = [];
    const source = createLiveSource({
      transport: createDecoderTransport({
        command: (d) => gstDecoderCommand(d, '/h'),
        token: () => 't',
        now: () => now,
        policy,
        spawn: f.spawn,
      }),
      accountId: 'a',
      deviceId: 'd',
      battery: true,
      now: () => now,
      onStatus: (s) => statuses.push(s),
    });
    const polled = source.poll();
    await new Promise((r) => setImmediate(r));
    f.children[0].stdout.write(
      record({ pts_ns: '9', ref: { clock: 'timestamp/x-ntp', ts_ns: String(ntpNs(now - 200)) } }),
    );
    const frame = await polled;
    await source.stop();
    return { frame, statuses, child: f.children[0] };
  }
  it('with the shipped no-go policy, a decoded frame falls back to the clip', async () => {
    const { frame, statuses, child } = await run();
    expect(frame).toBeUndefined();
    expect(statuses).toContain('clip: untrusted or stale live evidence');
    expect(child.kills).toContain('SIGTERM'); // stop() tears the helper down
  });
  it('with a trusted reference policy, the frame is accepted with its reference time', async () => {
    const { frame } = await run(TRUST);
    expect(frame?.timestampAuthority).toBe('ring');
    expect(frame?.captureTs).toBe(1_760_000_000_000 - 200);
  });
});

const hasGst = (() => {
  try {
    execFileSync('python3', [
      '-c',
      'import gi; gi.require_version("Gst","1.0"); from gi.repository import Gst; Gst.init(None); ' +
        'import sys; sys.exit(0 if all(Gst.ElementFactory.find(n) for n in ["videotestsrc","jpegenc","appsink"]) else 1)',
    ]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGst)('real GStreamer helper on a synthetic source', () => {
  it('decodes JPEG frames, labels them arrival, and exits on close', async () => {
    const helper = new URL('../scripts/live-decoder.py', import.meta.url).pathname;
    let child: ChildProcess | undefined;
    const t = createDecoderTransport({
      command: () => ({
        file: 'python3',
        args: [helper, '--test-source', '--interval-ms', '100', '--max-seconds', '10'],
      }),
      token: () => '',
      now: Date.now,
      spawn: (file, args, o) => (child = spawn(file, args, o)),
    });
    const s = await t.open('a', 'd');
    const frames = [await s.read(), await s.read()];
    for (const f of frames) {
      expect(f?.jpeg[0]).toBe(0xff);
      expect(f?.jpeg[1]).toBe(0xd8);
      expect(f?.timestampAuthority).toBe('arrival');
    }
    await s.close();
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  }, 15_000);
});
