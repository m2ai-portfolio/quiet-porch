// Live-frame decoder transport (QP-08): a LiveTransport backed by scripts/live-decoder.py, the
// GStreamer path proven in the authorized Cam1 spike. One decoder process per session; the
// session lifecycle (battery renewal, 3 s bounds, freshness, clip fallback) stays in
// createLiveSource. Capture time comes only from deriveCaptureTime; under LIVE_CAPTURE_NO_GO
// every frame is 'arrival', so createLiveSource rejects it and the clip path is used.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { LiveFrame, LiveSession, LiveTransport } from './live-source.ts';
import { rtspsEndpoint } from './live-source.ts';
import { deriveCaptureTime, LIVE_CAPTURE_NO_GO, type CapturePolicy } from './capture-time.ts';

const MAGIC = Buffer.from('QPF1');
const MAX_HEADER_BYTES = 4096;
const MAX_JPEG_BYTES = 4 * 1024 * 1024;
export const DECODER_KILL_GRACE_MS = 2000;

export interface DecodedRecord {
  ptsNs: bigint | null;
  reference: { clock: string; timestampNs: bigint } | null;
  jpeg: Buffer;
}

const nsString = (v: unknown): bigint | null =>
  typeof v === 'string' && /^\d{1,24}$/.test(v) ? BigInt(v) : null;

// Incremental parser for the helper's framed stdout. Throws on corrupt or oversized input; the
// session treats that as a dead decoder rather than resynchronising on guessed boundaries.
export function createFrameParser() {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): DecodedRecord[] {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out: DecodedRecord[] = [];
      for (;;) {
        if (buf.length < 8) break;
        if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('decoder_bad_magic');
        const headerLen = buf.readUInt32BE(4);
        if (headerLen > MAX_HEADER_BYTES) throw new Error('decoder_header_too_large');
        if (buf.length < 8 + headerLen + 4) break;
        const jpegLen = buf.readUInt32BE(8 + headerLen);
        if (jpegLen > MAX_JPEG_BYTES) throw new Error('decoder_frame_too_large');
        const end = 12 + headerLen + jpegLen;
        if (buf.length < end) break;
        let header: { pts_ns?: unknown; ref?: { clock?: unknown; ts_ns?: unknown } | null };
        try {
          header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'));
        } catch {
          throw new Error('decoder_bad_header');
        }
        const refTs = nsString(header.ref?.ts_ns);
        out.push({
          ptsNs: nsString(header.pts_ns),
          reference:
            header.ref && typeof header.ref.clock === 'string' && refTs !== null
              ? { clock: header.ref.clock, timestampNs: refTs }
              : null,
          jpeg: Buffer.from(buf.subarray(12 + headerLen, end)),
        });
        buf = buf.subarray(end);
      }
      return out;
    },
  };
}

export type SpawnFn = (
  file: string,
  args: string[],
  opts: { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

export interface DecoderCommand {
  file: string;
  args: string[];
}

// The production command: the token is written to stdin, never placed in argv.
export function gstDecoderCommand(deviceId: string, helper?: string): DecoderCommand {
  return {
    file: 'python3',
    args: [
      helper ?? new URL('../scripts/live-decoder.py', import.meta.url).pathname,
      '--location',
      rtspsEndpoint(deviceId),
    ],
  };
}

export function createDecoderTransport(opts: {
  command: (deviceId: string) => DecoderCommand;
  token: () => string;
  now: () => number;
  policy?: CapturePolicy;
  spawn?: SpawnFn;
  onDiagnostic?: (line: string) => void;
}): LiveTransport {
  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
  const policy = opts.policy ?? LIVE_CAPTURE_NO_GO;
  return {
    async open(accountId, deviceId) {
      const { file, args } = opts.command(deviceId);
      const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.stdin!.on('error', () => {}); // a helper that exits early must not crash ProBook
      child.stdin!.end(`${opts.token()}\n`);
      return decoderSession(child, accountId, deviceId);
    },
  };

  function decoderSession(child: ChildProcess, accountId: string, deviceId: string): LiveSession {
    const parser = createFrameParser();
    let newest: LiveFrame | undefined; // newest only: an older queued frame is never evidence
    let failure: Error | undefined;
    let closed = false;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    const waiters: Array<() => void> = [];
    const wake = () => waiters.splice(0).forEach((w) => w());
    const fail = (e: Error) => {
      failure ??= e;
      wake();
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      let records: DecodedRecord[];
      try {
        records = parser.push(chunk);
      } catch (e) {
        fail(e as Error);
        child.kill('SIGTERM');
        return;
      }
      for (const r of records) {
        const receivedAt = opts.now();
        const t = deriveCaptureTime({ ptsNs: r.ptsNs, reference: r.reference, receivedAt }, policy);
        if (t.authority === 'arrival') opts.onDiagnostic?.(`capture_time:${t.reason}`);
        newest = {
          jpeg: r.jpeg,
          captureTs: t.captureTs,
          timestampAuthority: t.authority,
          accountId,
          deviceId,
        };
      }
      if (records.length) wake();
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) opts.onDiagnostic?.(line.trim().slice(0, 200));
      }
    });
    child.once('error', (e) => fail(e));
    void exited.then(() => fail(new Error('decoder_exited')));
    return {
      async read() {
        if (closed) return undefined;
        if (!newest && !failure) await new Promise<void>((r) => waiters.push(r));
        if (closed) return undefined;
        if (newest) {
          const f = newest;
          newest = undefined;
          return f;
        }
        throw failure ?? new Error('decoder_exited');
      },
      async close() {
        if (!closed) {
          closed = true;
          wake();
        }
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const graceful = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((r) => {
            timer = setTimeout(() => r(false), DECODER_KILL_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
        if (!graceful) {
          child.kill('SIGKILL');
          await exited;
        }
      },
    };
  }
}
