import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireEventFrame,
  checkEventFrame,
  parseMotionEvent,
  probeFollowUps,
  type MotionEvent,
} from '../src/frames.ts';
import { downloadImageAt, type ImageAttempt } from '../src/ring.ts';

const EVENT_TS = 1_000_000;
const RECEIVED = EVENT_TS + 1000;
const ev: MotionEvent = {
  accountId: 'acct',
  deviceId: 'cam-1',
  eventId: 'e1',
  subType: 'human',
  eventTs: EVENT_TS,
  receivedAt: RECEIVED,
};
const JPEG = Buffer.from([0xff, 0xd8, 1]);
const good = (dt = 0): ImageAttempt => ({
  status: 200,
  step: 2,
  content_type: 'image/jpeg',
  bytes: 3,
  media_timestamp: EVENT_TS + dt,
  media_origin: 'recording',
  image: JPEG,
});

// Fake clock: sleep advances time instead of waiting.
function clock() {
  let t = RECEIVED;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('checkEventFrame', () => {
  it('accepts a recording within 1000 ms of the event (611 ms seen on Front Door)', () => {
    expect(checkEventFrame(good(611), EVENT_TS, RECEIVED)).toEqual({ ok: true });
    expect(checkEventFrame(good(-1000), EVENT_TS, RECEIVED)).toEqual({ ok: true });
  });

  it.each([
    ['a fresh snapshot', { ...good(), media_origin: 'snapshot' }, 'origin_snapshot'],
    ['a recording 1500 ms before the event', good(-1500), 'capture_outside_tolerance'],
    [
      'a capture after receipt',
      { ...good(), media_timestamp: RECEIVED + 1 },
      'capture_after_receipt',
    ],
    ['no X-Media-Timestamp', { ...good(), media_timestamp: undefined }, 'no_media_timestamp'],
    ['not a jpeg', { ...good(), content_type: 'text/html' }, 'not_jpeg'],
    ['a 425', { status: 425, step: 1 } as ImageAttempt, 'http_425'],
  ])('rejects %s', (_name, attempt, reason) => {
    expect(checkEventFrame(attempt as ImageAttempt, EVENT_TS, RECEIVED)).toEqual({
      ok: false,
      reason,
    });
  });
});

describe('acquireEventFrame', () => {
  it('retries at the planned offsets and returns the first accepted frame', async () => {
    const c = clock();
    const answers: ImageAttempt[] = [
      { status: 425, step: 1, error_code: 'RECORDING_NOT_READY' },
      good(300),
    ];
    const download = vi.fn(async () => answers.shift()!);
    const { frame, record } = await acquireEventFrame(ev, download, c);
    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledWith('acct', 'cam-1', EVENT_TS, { keepImage: true });
    expect(frame).toEqual({ jpeg: JPEG, captureTs: EVENT_TS + 300, origin: 'recording' });
    expect(record.attempts.map((a) => [a.offset_ms, a.status])).toEqual([
      [0, 425],
      [2000, 200],
    ]);
    expect(record.ready_after_event_ms).toBe(3000);
    expect(JSON.stringify(record)).not.toContain('"image"');
  });

  it('retries after a rejected snapshot and accepts the later recording', async () => {
    const answers = [{ ...good(), media_origin: 'snapshot' }, good(0)];
    const { frame, record } = await acquireEventFrame(ev, async () => answers.shift()!, clock());
    expect(frame?.origin).toBe('recording');
    expect(record.attempts[0].rejected).toBe('origin_snapshot');
  });

  it('returns no frame when it never becomes ready, logging every attempt', async () => {
    const { frame, record } = await acquireEventFrame(
      ev,
      async () => ({ status: 425, step: 1 }),
      clock(),
    );
    expect(frame).toBeUndefined();
    expect(record.attempts.map((a) => a.offset_ms)).toEqual([
      0, 2000, 5000, 8000, 12000, 16000, 20000,
    ]);
    expect(record.ready_after_event_ms).toBeUndefined();
  });

  it('waits past +5 s: a recording that first appears at +8 s is still the event frame', async () => {
    const answers: ImageAttempt[] = [
      { status: 416, step: 2, error_code: 'MEDIA_NOT_FOUND' },
      { status: 416, step: 2, error_code: 'MEDIA_NOT_FOUND' },
      { status: 416, step: 2, error_code: 'MEDIA_NOT_FOUND' },
      good(0),
    ];
    const { frame, record } = await acquireEventFrame(ev, async () => answers.shift()!, clock());
    expect(frame?.origin).toBe('recording');
    expect(record.attempts.map((a) => a.offset_ms)).toEqual([0, 2000, 5000, 8000]);
  });

  it('records a network error as status 0 and keeps going', async () => {
    const download = vi
      .fn<() => Promise<ImageAttempt>>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(good());
    const { frame, record } = await acquireEventFrame(ev, download, clock());
    expect(record.attempts[0]).toMatchObject({
      status: 0,
      error_code: 'FETCH_ERROR',
      detail: 'socket hang up',
    });
    expect(frame).toBeDefined();
  });
});

describe('probeFollowUps', () => {
  it('requests now - 2 s at each offset and reports the frame offset, without image bytes', async () => {
    const c = clock();
    const calls: number[] = [];
    const out = await probeFollowUps(
      ev,
      async (_a, _d, ts) => {
        calls.push(ts);
        return { ...good(), media_timestamp: ts + 400 };
      },
      c,
    );
    expect(calls).toEqual([
      RECEIVED + 5000 - 2000,
      RECEIVED + 10000 - 2000,
      RECEIVED + 15000 - 2000,
    ]);
    expect(out.map((f) => f.frame_minus_requested_ms)).toEqual([400, 400, 400]);
    expect(JSON.stringify(out)).not.toContain('"image"');
  });
});

describe('parseMotionEvent', () => {
  const body = {
    meta: { account_id: 'acct' },
    data: {
      id: 'cam-1_human_1',
      type: 'motion_detected',
      attributes: { source: 'cam-1', sub_type: 'human', timestamp: EVENT_TS },
    },
  };

  it('extracts account, device, event id, sub_type and event time', () => {
    expect(parseMotionEvent(body, 5)).toEqual({
      accountId: 'acct',
      deviceId: 'cam-1',
      eventId: 'cam-1_human_1',
      subType: 'human',
      eventTs: EVENT_TS,
      receivedAt: 5,
    });
  });

  it('ignores other event types and malformed motion events', () => {
    expect(
      parseMotionEvent({ ...body, data: { ...body.data, type: 'device_added' } }, 5),
    ).toBeUndefined();
    expect(parseMotionEvent({ data: { type: 'motion_detected' } }, 5)).toBeUndefined();
    const noTs = { ...body, data: { ...body.data, attributes: { source: 'cam-1' } } };
    expect(parseMotionEvent(noTs, 5)).toBeUndefined();
  });
});

describe('downloadImageAt', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub() {
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
    return calls;
  }

  it('POSTs an at_timestamp request, follows the 303 and reports media headers', async () => {
    const calls = stub();
    const r = await downloadImageAt('AT', 'dev-1', EVENT_TS);
    expect(calls[0].url).toBe('https://api.amazonvision.com/v1/devices/dev-1/media/image/download');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      type: 'at_timestamp',
      timestamp: EVENT_TS,
      image_options: { format: 'jpeg' },
    });
    expect(r).toEqual({
      status: 200,
      step: 2,
      content_type: 'image/jpeg',
      bytes: 3,
      media_timestamp: EVENT_TS + 611,
      media_origin: 'recording',
    });
  });

  it('keeps the image bytes only when asked', async () => {
    stub();
    const r = await downloadImageAt('AT', 'dev-1', EVENT_TS, { keepImage: true });
    expect(r.image).toEqual(Buffer.from([1, 2, 3]));
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

describe('encrypted video still answers 200 (Ring docs, F12)', () => {
  it('a 200 whose bytes are not a JPEG is refused as not_jpeg_bytes', () => {
    const t = 1_791_400_000_000;
    const base = {
      status: 200,
      step: 2 as const,
      content_type: 'image/jpeg',
      media_timestamp: t,
      media_origin: 'recording',
    };
    expect(
      checkEventFrame({ ...base, image: Buffer.from([0x01, 0x02, 0x03]) }, t, t + 500),
    ).toEqual({ ok: false, reason: 'not_jpeg_bytes' });
    expect(checkEventFrame({ ...base, image: Buffer.from([0xff, 0xd8, 1]) }, t, t + 500)).toEqual({
      ok: true,
    });
  });
});

describe('downloadImageAt request ids (F10)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the request id of the step-1 POST, on success and on a refusal', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      if (n === 1) {
        return new Response(null, {
          status: 303,
          headers: { Location: 'https://media/x', 'X-Request-Id': 'rid-post' },
        });
      }
      return new Response(new Uint8Array([0xff, 0xd8]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'X-Media-Origin': 'recording' },
      });
    });
    const ok = await downloadImageAt('AT', 'dev-1', 1);
    expect(ok.request_id).toBe('rid-post');
    expect(ok).not.toHaveProperty('media_request_id');

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('{"error":"RECORDING_NOT_READY"}', {
          status: 425,
          headers: { 'x-amzn-RequestId': 'rid-425' },
        }),
    );
    const refused = await downloadImageAt('AT', 'dev-1', 1);
    expect(refused).toMatchObject({ status: 425, step: 1, request_id: 'rid-425' });
    expect(refused.error_code).toBe('RECORDING_NOT_READY');
  });
});
