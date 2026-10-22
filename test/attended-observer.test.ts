import { expect, it, vi } from 'vitest';
import { createAttendedObserver } from '../src/attended-observer.ts';
import { createAttendedTest } from '../src/attended-test.ts';
import type { ContentBlock } from '../src/bedrock.ts';
import type { ImageAttempt } from '../src/ring.ts';
import type { PipelineConfig } from '../src/pipeline.ts';
const scope = { accountId: 'owner', deviceId: 'cam', zone: 'front_yard' };
const cfg: PipelineConfig = {
  dryRun: true,
  zones: { cam: 'front_yard' },
  timezone: 'UTC',
  nightWindow: { start: '20:00', end: '06:30' },
  followUpProbe: false,
  wildlifeMaxEvidenceAgeMs: 35000,
  context: {
    mode: 'night',
    knownPets: [],
    expectedVisitors: [],
    routines: [],
    nuisanceSpecies: [],
  },
};
function rig(extra: { followUpLookbackMs?: number } = {}) {
  let now = 100000,
    allowed = true,
    empty = false;
  let alter: (image: ImageAttempt) => ImageAttempt = (image) => image;
  const download = vi.fn(async (_account: string, _device: string, ts: number) =>
    alter({
      status: 200,
      step: 2,
      content_type: 'image/jpeg',
      media_origin: 'recording',
      media_timestamp: ts,
      image: Buffer.from([255, 216, 1, 2]),
    }),
  );
  const converse = vi.fn(async (content: ContentBlock[]) => {
    const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
    const id = text.match(/ev_[a-f0-9]{24}/)?.[0];
    return JSON.stringify(
      content.some((c) => 'image' in c)
        ? {
            evidence_id: id,
            subjects: empty ? [] : [{ class: 'person', confidence: 0.99 }],
            person_present: !empty,
            activity: 'standing',
            night_ir: true,
          }
        : { evidence_id: id, verdict: 'unknown', reasons: ['test only'] },
    );
  });
  const audit = vi.fn();
  const observer = createAttendedObserver({
    ...extra,
    scope,
    config: () => cfg,
    download,
    converse,
    allowed: () => allowed,
    audit,
    now: () => now,
  });
  return {
    observer,
    download,
    converse,
    audit,
    setTime: (n: number) => {
      now = n;
    },
    empty: () => {
      empty = true;
    },
    revoke: () => {
      allowed = false;
    },
    alter: (f: typeof alter) => {
      alter = f;
    },
  };
}
it('camera pixels and capture timestamps drive 45s dwell, single alert/speech, and observed departure', async () => {
  const r = rig();
  let now = 100000;
  const calls: string[] = [];
  const t = createAttendedTest({
    scope,
    wall: () => now,
    mono: () => now - 100000,
    authorize: () => true,
    killed: () => false,
    ready: async () => true,
    audit: () => {},
    outputs: {
      alert: async () => {
        calls.push('alert');
      },
      speak: async () => {
        calls.push('speech');
      },
      stop: async () => {
        calls.push('stop');
      },
    },
  });
  try {
    await t.arm();
    await t.feed({
      ...scope,
      id: 'newly-ingested-trigger',
      captureTs: now,
      source: 'ring',
      verdict: 'person',
    });
    for (let s = 4; s <= 46; s += 2) {
      now = 100000 + s * 1000;
      r.setTime(now);
      const ev = await r.observer.poll();
      expect(ev?.verdict).toBe('person');
      if (ev) await t.feed(ev);
    }
    expect(calls).toEqual(['alert', 'speech']);
    r.empty();
    now += 2000;
    r.setTime(now);
    const ev = await r.observer.poll();
    expect(ev?.verdict).toBe('empty');
    if (ev) await t.feed(ev);
    expect(calls).toEqual(['alert', 'speech', 'stop']);
    expect(t.status().endReason).toBe('departure');
  } finally {
    await t.disarm();
  }
});
it.each([
  (i: ImageAttempt) => ({ ...i, media_origin: 'snapshot' }),
  (i: ImageAttempt) => ({ ...i, media_timestamp: undefined }),
  (i: ImageAttempt) => ({ ...i, media_timestamp: 1 }),
  (i: ImageAttempt) => ({ ...i, image: Buffer.from([0, 0]) }),
])('rejects snapshot/missing time/stale/non-JPEG without inference', async (alter) => {
  const r = rig();
  r.alter(alter);
  expect(await r.observer.poll()).toBeUndefined();
  expect(r.converse).not.toHaveBeenCalled();
});
it('stops permanently after an authorization refusal without retry', async () => {
  const r = rig();
  r.alter((i) => ({ ...i, status: 403 }));
  await expect(r.observer.poll()).rejects.toThrow('camera_access_denied');
  r.setTime(104000);
  expect(await r.observer.poll()).toBeUndefined();
  expect(r.download).toHaveBeenCalledTimes(1);
});
it('rechecks permission after download before inference', async () => {
  const r = rig();
  r.alter((i) => {
    r.revoke();
    return i;
  });
  expect(await r.observer.poll()).toBeUndefined();
  expect(r.converse).not.toHaveBeenCalled();
});
it('rejects inference that finishes after evidence expiry', async () => {
  const r = rig();
  r.converse.mockImplementationOnce(async (content) => {
    r.setTime(106000);
    const id = content
      .map((c) => ('text' in c ? c.text : ''))
      .join(' ')
      .match(/ev_[a-f0-9]{24}/)?.[0];
    return JSON.stringify({
      evidence_id: id,
      subjects: [],
      person_present: false,
      activity: 'empty',
      night_ir: true,
    });
  });
  expect(await r.observer.poll()).toBeUndefined();
  expect(r.audit).toHaveBeenCalledWith({
    event: 'followup_rejected',
    reason: 'model_result_stale',
  });
});
it('never polls an inactive session', async () => {
  const r = rig();
  r.revoke();
  expect(await r.observer.poll()).toBeUndefined();
  expect(r.download).not.toHaveBeenCalled();
});
it('requests follow-up frames 2 s back by default and at the configured lookback when given', async () => {
  const dflt = rig();
  await dflt.observer.poll();
  expect(dflt.download).toHaveBeenCalledWith('owner', 'cam', 98000, { keepImage: true });
  const short = rig({ followUpLookbackMs: 1500 });
  await short.observer.poll();
  expect(short.download).toHaveBeenCalledWith('owner', 'cam', 98500, { keepImage: true });
});
it('a 416 follow-up is rejected with Ring status, error code, request id and poll context', async () => {
  const r = rig({ followUpLookbackMs: 1500 });
  r.alter(() => ({ status: 416, step: 1, error_code: 'MEDIA_NOT_FOUND', request_id: 'rid-1' }));
  expect(await r.observer.poll()).toBeUndefined();
  expect(r.converse).not.toHaveBeenCalled();
  expect(r.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'followup_rejected',
      reason: 'http_416',
      http_status: 416,
      step: 1,
      error_code: 'MEDIA_NOT_FOUND',
      request_id: 'rid-1',
      poll: 1,
      requested_ts: 98500,
    }),
  );
  // The observer keeps polling after a 416: the next poll is admitted once 2 s have passed.
  r.setTime(102000);
  r.alter((image) => image);
  expect(r.download).toHaveBeenCalledTimes(1);
  await r.observer.poll();
  expect(r.download).toHaveBeenCalledTimes(2);
});
