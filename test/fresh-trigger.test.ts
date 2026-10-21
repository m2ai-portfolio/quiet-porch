import { afterEach, expect, it, vi } from 'vitest';
import { openDb, recordEvent } from '../src/db.ts';
import { readMotionWakeups } from '../src/attended-source.ts';
import { createYardMonitor } from '../src/yard-monitor.ts';
import { createAttendedObserver } from '../src/attended-observer.ts';
import { judgeFreshFrame } from '../src/fresh-judgement.ts';
import type { ContentBlock } from '../src/bedrock.ts';
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
const jpeg = Buffer.from([255, 216, 1, 2]);
afterEach(() => vi.useRealTimers());
function response(content: ContentBlock[], verdict = 'unknown', criticPerson = true) {
  const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
  const id = text.match(/ev_[a-f0-9]{24}/)?.[0];
  return JSON.stringify(
    text.includes('independent visual critique')
      ? { evidence_id: id, verdict, person_present: criticPerson, reasons: ['fixture only'] }
      : {
          evidence_id: id,
          subjects: [{ class: 'person', confidence: 0.99 }],
          person_present: true,
          activity: 'walking',
          night_ir: true,
        },
  );
}
it('reads a signed-ingestion wake before completed analysis exists, and never treats 8.404s-old pixels as fresh', async () => {
  const db = openDb(':memory:');
  let now = 100000;
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const m = createYardMonitor({
    scope,
    authorized: () => true,
    night: () => true,
    killed: () => false,
    ready: async () => true,
    outputs: () => outputs,
    audit: () => {},
    reserve: () => {},
    initialCooldown: 0,
    now: () => now,
    mono: () => now - 100000,
  });
  try {
    recordEvent(
      db,
      {
        source: 'ring',
        sourceEventId: 'real-shape-event',
        type: 'motion_detected',
        zone: scope.zone,
        payload: {
          meta: { account_id: 'owner' },
          data: {
            id: 'real-shape-event',
            type: 'motion_detected',
            attributes: { source: 'cam', timestamp: 100000 },
          },
        },
      },
      100981,
    );
    now = 100981;
    const early = readMotionWakeups(db, 0, scope, now);
    expect(early.wakes).toHaveLength(1);
    expect(db.prepare('select count(*) n from decisions').get()?.n).toBe(0);
    await m.wake(early.wakes[0]);
    expect(m.current()?.status().encounterStarted).toBe(false);
    now = 108404;
    await m.feed({
      ...scope,
      id: 'late-decision-frame',
      captureTs: 100000,
      source: 'ring',
      verdict: 'person',
    });
    expect(m.current()?.status().encounterStarted).toBe(false);
    expect(outputs.alert).not.toHaveBeenCalled();
    expect(outputs.speak).not.toHaveBeenCalled();
    await m.feed({
      ...scope,
      id: 'fresh-new-pixels',
      captureTs: now - 1000,
      source: 'ring',
      verdict: 'person',
    });
    expect(m.current()?.status().encounterStarted).toBe(true);
  } finally {
    await m.stop('test');
    db.close();
  }
});
it('old, future, wrong-account and synthetic metadata cannot wake observation', () => {
  const db = openDb(':memory:');
  try {
    for (const [n, source, account, ts] of [
      [1, 'ring', 'owner', 80000],
      [2, 'ring', 'owner', 100001],
      [3, 'ring', 'other', 100000],
      [4, 'synthetic', 'owner', 100000],
    ] as const)
      recordEvent(
        db,
        {
          source,
          sourceEventId: String(n),
          type: 'motion_detected',
          zone: scope.zone,
          payload: {
            meta: { account_id: account },
            data: {
              id: String(n),
              type: 'motion_detected',
              attributes: { source: 'cam', timestamp: ts },
            },
          },
        },
        100000,
      );
    expect(readMotionWakeups(db, 0, scope, 100000).wakes).toHaveLength(0);
  } finally {
    db.close();
  }
});
it('perception and independent critique run concurrently on the same fresh capture', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  let inFlight = 0,
    maxInFlight = 0;
  const starts = Date.now();
  const converse = vi.fn(async (content: ContentBlock[]) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
    await new Promise((r) =>
      setTimeout(r, text.includes('independent visual critique') ? 2326 : 2563),
    );
    inFlight--;
    return response(content);
  });
  const p = judgeFreshFrame(
    jpeg,
    98000,
    'ev_0123456789abcdef01234567',
    'front_yard',
    cfg,
    converse,
  );
  await vi.advanceTimersByTimeAsync(2563);
  const r = await p;
  expect(r.decision.kind).toBe('intruder');
  expect(maxInFlight).toBe(2);
  expect(Date.now() - starts).toBe(2563);
  expect(Date.now() - 98000).toBeLessThan(6000);
  const images = converse.mock.calls.map(([c]) => c.find((x) => 'image' in x));
  expect(images[0]).toEqual(images[1]);
});
it.each(['benign', 'uncertain'])(
  'fresh independent %s critique vetoes outputs',
  async (verdict) => {
    const r = await judgeFreshFrame(
      jpeg,
      100000,
      'ev_0123456789abcdef01234567',
      'front_yard',
      cfg,
      async (c) => response(c, verdict),
    );
    expect(r.decision.kind).toBe('log');
  },
);
it('independent person-presence disagreement rejects the observation', async () => {
  const r = await judgeFreshFrame(
    jpeg,
    100000,
    'ev_0123456789abcdef01234567',
    'front_yard',
    cfg,
    async (c) => response(c, 'unknown', false),
  );
  expect(r.decision).toEqual({ kind: 'reject', reason: 'independent_judgement_disagreement' });
});
it('8.404s inference is rejected even with the parallel path', async () => {
  let now = 100000;
  const audit = vi.fn();
  const o = createAttendedObserver({
    parallelCritique: true,
    scope,
    config: () => cfg,
    allowed: () => true,
    now: () => now,
    audit,
    download: async (_a, _d, ts) => ({
      status: 200,
      step: 2,
      content_type: 'image/jpeg',
      media_origin: 'recording',
      media_timestamp: ts,
      image: jpeg,
    }),
    converse: async (c) => {
      now = 108404;
      return response(c);
    },
  });
  expect(await o.poll()).toBeUndefined();
  expect(audit).toHaveBeenCalledWith({ event: 'followup_rejected', reason: 'model_result_stale' });
});
it('cancellation after wake prevents later fresh observations from actuating', async () => {
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const m = createYardMonitor({
    scope,
    authorized: () => true,
    night: () => true,
    killed: () => false,
    ready: async () => true,
    outputs: () => outputs,
    audit: () => {},
    reserve: () => {},
    initialCooldown: 0,
    now: () => 100000,
  });
  await m.wake({ ...scope, id: 'wake', eventTs: 100000, source: 'ring_event' });
  await m.stop('cancel');
  await m.feed({ ...scope, id: 'late', captureTs: 100000, source: 'ring', verdict: 'person' });
  expect(outputs.alert).not.toHaveBeenCalled();
  expect(outputs.speak).not.toHaveBeenCalled();
});
it('speech dispatch rechecks capture freshness after adapter preparation', async () => {
  let now = 100000;
  let physicalSpeech = 0;
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async (_id: string, _signal: AbortSignal, allowed: () => boolean) => {
      now += 2000;
      if (!allowed()) throw new Error('expired');
      physicalSpeech++;
    }),
    stop: vi.fn(async () => {}),
  };
  const m = createYardMonitor({
    scope,
    authorized: () => true,
    night: () => true,
    killed: () => false,
    ready: async () => true,
    outputs: () => outputs,
    audit: () => {},
    reserve: () => {},
    initialCooldown: 0,
    now: () => now,
    mono: () => now - 100000,
  });
  try {
    await m.wake({ ...scope, id: 'wake', eventTs: now, source: 'ring_event' });
    for (let s = 0; s <= 20; s += 5) {
      now = 100000 + s * 1000 + 4500;
      await m.feed({
        ...scope,
        id: 'frame' + s,
        captureTs: 100000 + s * 1000,
        source: 'ring',
        verdict: 'person',
      });
    }
    expect(outputs.alert).toHaveBeenCalledTimes(1);
    expect(physicalSpeech).toBe(0);
    expect(m.status().running).toBe(false);
  } finally {
    await m.stop('test');
  }
});
