import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrameProbe, parseMotionEvent, type ProbeRecord } from '../src/frame-probe.ts';
import { downloadImageAt, type ImageAttempt } from '../src/ring.ts';

const EVENT_TS = 1_000_000;
const ev = (deviceId = 'cam-1') => ({
  accountId: 'acct',
  deviceId,
  subType: 'human',
  eventTs: EVENT_TS,
  receivedAt: EVENT_TS + 1000,
});

// Fake clock: sleep advances time instead of waiting.
function clock() {
  let t = EVENT_TS + 1000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe('frame probe', () => {
  it('retries at the planned offsets and stops at the first 200', async () => {
    const c = clock();
    const answers: ImageAttempt[] = [
      { status: 425, step: 1, error_code: 'RECORDING_NOT_READY' },
      {
        status: 200,
        step: 2,
        bytes: 5,
        media_timestamp: EVENT_TS + 300,
        media_origin: 'recording',
      },
      { status: 200, step: 2 },
    ];
    const download = vi.fn(async () => {
      c.tick(100);
      return answers.shift()!;
    });
    const records: ProbeRecord[] = [];
    await createFrameProbe({ download, write: (r) => records.push(r), ...c }).run(ev());

    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledWith('acct', 'cam-1', EVENT_TS);
    const [r] = records;
    expect(r.attempts.map((a) => [a.offset_ms, a.sent_after_event_ms, a.status])).toEqual([
      [0, 1000, 425],
      [2000, 3000, 200],
    ]);
    expect(r.attempts[0].error_code).toBe('RECORDING_NOT_READY');
    expect(r.attempts[1].frame_minus_event_ms).toBe(300);
    expect(r.ready_after_event_ms).toBe(3100);
  });

  it('logs every attempt and no ready time when the frame never arrives', async () => {
    const c = clock();
    const records: ProbeRecord[] = [];
    const download = vi.fn(async (): Promise<ImageAttempt> => ({ status: 425, step: 1 }));
    await createFrameProbe({ download, write: (r) => records.push(r), ...c }).run(ev());
    expect(records[0].attempts.map((a) => a.offset_ms)).toEqual([0, 2000, 5000]);
    expect(records[0].ready_after_event_ms).toBeUndefined();
  });

  it('records a network error as status 0 and keeps going', async () => {
    const c = clock();
    const records: ProbeRecord[] = [];
    const download = vi
      .fn<() => Promise<ImageAttempt>>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ status: 200, step: 2 });
    await createFrameProbe({ download, write: (r) => records.push(r), ...c }).run(ev());
    expect(records[0].attempts[0]).toMatchObject({
      status: 0,
      error_code: 'FETCH_ERROR',
      detail: 'socket hang up',
    });
    expect(records[0].attempts[1].status).toBe(200);
  });

  it('skips a second event on the same camera while one probe is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const records: ProbeRecord[] = [];
    const download = vi.fn(async (): Promise<ImageAttempt> => {
      await gate;
      return { status: 200, step: 2 };
    });
    const probe = createFrameProbe({ download, write: (r) => records.push(r) });
    const first = probe.run({ ...ev(), receivedAt: Date.now() });
    await probe.run({ ...ev(), receivedAt: Date.now() });
    const other = probe.run({ ...ev('cam-2'), receivedAt: Date.now() });
    expect(records[0].skipped).toBe('in_flight');
    release();
    await Promise.all([first, other]);
    expect(download).toHaveBeenCalledTimes(2); // cam-1 once, cam-2 once
    expect(records.filter((r) => !r.skipped)).toHaveLength(2);
  });
});

describe('parseMotionEvent', () => {
  const body = {
    meta: { account_id: 'acct' },
    data: {
      type: 'motion_detected',
      attributes: { source: 'cam-1', sub_type: 'human', timestamp: EVENT_TS },
    },
  };

  it('extracts account, device, sub_type and event time', () => {
    expect(parseMotionEvent(body, 5)).toEqual({
      accountId: 'acct',
      deviceId: 'cam-1',
      subType: 'human',
      eventTs: EVENT_TS,
      receivedAt: 5,
    });
  });

  it('ignores other event types and malformed motion events', () => {
    expect(parseMotionEvent({ ...body, data: { ...body.data, type: 'device_added' } }, 5)).toBe(
      undefined,
    );
    expect(parseMotionEvent({ data: { type: 'motion_detected' } }, 5)).toBeUndefined();
    const noTs = { ...body, data: { ...body.data, attributes: { source: 'cam-1' } } };
    expect(parseMotionEvent(noTs, 5)).toBeUndefined();
  });
});

describe('downloadImageAt', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs an at_timestamp request, follows the 303 and reports media headers', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(null, { status: 303, headers: { Location: 'https://media/x' } });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Media-Timestamp': String(EVENT_TS + 611),
          'X-Media-Origin': 'recording',
        },
      });
    });
    const r = await downloadImageAt('AT', 'dev-1', EVENT_TS);
    expect(calls[0].url).toBe('https://api.amazonvision.com/v1/devices/dev-1/media/image/download');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      type: 'at_timestamp',
      timestamp: EVENT_TS,
      image_options: { format: 'jpeg' },
    });
    expect(calls[1].url).toBe('https://media/x');
    expect(r).toEqual({
      status: 200,
      step: 2,
      content_type: 'image/jpeg',
      bytes: 3,
      media_timestamp: EVENT_TS + 611,
      media_origin: 'recording',
    });
  });

  it('returns the Ring error code when step 1 is refused', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ errors: [{ status: '425', code: 'RECORDING_NOT_READY' }] }), {
          status: 425,
        }),
    );
    expect(await downloadImageAt('AT', 'dev-1', EVENT_TS)).toEqual({
      status: 425,
      step: 1,
      error_code: 'RECORDING_NOT_READY',
    });
  });
});
