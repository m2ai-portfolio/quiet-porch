import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '../src/bedrock.ts';
import type { Evaluation } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import type { MotionEvent, ProbeRecord } from '../src/frames.ts';
import {
  createPipeline,
  parsePipelineConfig,
  type DecisionRecord,
  type PipelineConfig,
} from '../src/pipeline.ts';
import type { ImageAttempt } from '../src/ring.ts';

// 2026-10-08 23:00 CDT: inside the 20:00 to 06:30 night window.
const EVENT_TS = Date.parse('2026-10-08T23:00:00-05:00');
const ev = (id = 'e1', deviceId = 'cam-yard'): MotionEvent => ({
  accountId: 'acct',
  deviceId,
  eventId: id,
  subType: 'other_motion',
  eventTs: EVENT_TS,
  receivedAt: EVENT_TS + 1000,
});
const JPEG = Buffer.from([0xff, 0xd8, 7, 7]);
const frame: ImageAttempt = {
  status: 200,
  step: 2,
  content_type: 'image/jpeg',
  bytes: 4,
  media_timestamp: EVENT_TS,
  media_origin: 'recording',
  image: JPEG,
};

const cfg: PipelineConfig = parsePipelineConfig({
  dryRun: true,
  primaryAccountId: 'acct',
  timezone: 'America/Chicago',
  nightWindow: { start: '20:00', end: '06:30' },
  zones: { 'cam-yard': 'front_yard' },
  context: {
    mode: 'night',
    knownPets: [],
    expectedVisitors: [],
    routines: [],
    nuisanceSpecies: ['armadillo'],
  },
  followUpProbe: false,
});

// Fake Bedrock: answers perception with `subjects`, critique with `verdict`, echoing the
// evidence_id it was given, inside a code fence like the real model.
function fakeModel(subjects: unknown[], verdict: string, person_present = false) {
  return vi.fn(async (content: ContentBlock[]) => {
    const text = content.map((c) => ('text' in c ? c.text : '')).join('');
    const id = /"evidence_id": "(ev_[0-9a-f]+)"/.exec(text)?.[1];
    const isPerception = content.some((c) => 'image' in c);
    const body = isPerception
      ? { evidence_id: id, subjects, person_present, activity: 'walking', night_ir: true }
      : { evidence_id: id, verdict, reasons: ['test'] };
    return '```json\n' + JSON.stringify(body) + '\n```';
  });
}

describe('decision pipeline (dry run)', () => {
  let dir: string;
  let db: DatabaseSync;
  let decisions: DecisionRecord[];
  let probes: ProbeRecord[];
  let saved: string[];
  let t: number;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qp-pipe-'));
    db = openDb(join(dir, 'db.sqlite'));
    decisions = [];
    probes = [];
    saved = [];
    t = EVENT_TS + 1000;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function make(
    model: ReturnType<typeof fakeModel>,
    opts: {
      liveFrame?: () => Promise<import('../src/frames.ts').EventFrame | undefined>;
      killed?: boolean;
      download?: () => Promise<ImageAttempt>;
      onEvaluation?: (e: Evaluation) => void;
      config?: PipelineConfig;
    } = {},
  ) {
    return createPipeline(opts.config ?? cfg, {
      db,
      liveFrame: opts.liveFrame,
      download: opts.download ?? (async () => frame),
      converse: model,
      killed: () => opts.killed ?? false,
      writeProbe: (r) => probes.push(r),
      writeDecision: (r) => decisions.push(r),
      saveFrame: (id) => saved.push(id),
      onEvaluation: opts.onEvaluation,
      clock,
    });
  }

  it('a live-source failure falls back to the clip without inventing live provenance', async () => {
    const download = vi.fn(async () => frame);
    const result = await make(fakeModel([], 'benign'), {
      download,
      liveFrame: async () => {
        throw Error('stream offline');
      },
    }).handle(ev(), {});
    expect(download).toHaveBeenCalledOnce();
    expect(result?.kind).toBe('log');
    expect(db.prepare('SELECT source FROM evidence').get()).toMatchObject({
      source: 'ring:cam-yard',
    });
  });
  it('hands every decision to the coordinator with its evidence id, capture time and frame', async () => {
    const seen: Evaluation[] = [];
    const model = fakeModel([{ class: 'armadillo', confidence: 0.93 }], 'nuisance');
    const r = await make(model, { onEvaluation: (e) => seen.push(e) }).handle(ev(), {});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      zone: 'front_yard',
      kind: 'wildlife',
      species: 'armadillo',
      evidenceId: r!.evidence_id,
    });
    expect(typeof seen[0].captureTs).toBe('number');
    expect(Buffer.isBuffer(seen[0].frame)).toBe(true);
    const none: Evaluation[] = [];
    await make(model, {
      onEvaluation: (e) => none.push(e),
      download: async () => ({ status: 416, step: 2, error_code: 'MEDIA_NOT_FOUND' }),
    }).handle(ev('other-event'), {});
    expect(none).toMatchObject([{ kind: 'no_evidence' }]);
    expect(none[0].captureTs).toBeUndefined();
  });

  it('armadillo at night with a nuisance verdict: would run the wildlife profile, frame saved', async () => {
    const model = fakeModel([{ class: 'armadillo', confidence: 0.93 }], 'nuisance');
    const r = await make(model).handle(ev(), {});
    expect(r).toMatchObject({
      kind: 'wildlife',
      zone: 'front_yard',
      would: 'would run the wildlife profile in front_yard (armadillo)',
      dry_run: true,
    });
    expect(model).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([r!.evidence_id]);
    const row = db.prepare('SELECT kind, evidence_id, dry_run FROM decisions').get() as Record<
      string,
      unknown
    >;
    expect(row).toEqual({ kind: 'wildlife', evidence_id: r!.evidence_id, dry_run: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 });
    expect(probes).toHaveLength(1);
  });

  it('nothing actionable: logged after one model call, no critique, no frame kept', async () => {
    const model = fakeModel([{ class: 'cat', confidence: 0.9 }], 'benign');
    const r = await make(model).handle(ev(), {});
    expect(r).toMatchObject({ kind: 'log', reason: 'nothing_actionable' });
    expect(model).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
  });

  it('after primaryAccountId is removed from config, a once-primary household gets no evaluation', async () => {
    const model = fakeModel([{ class: 'armadillo', confidence: 0.93 }], 'nuisance');
    const first: Evaluation[] = [];
    await make(model, { onEvaluation: (e) => first.push(e) }).handle(ev('before'), {});
    expect(first).toHaveLength(1); // persisted 'acct' as primary
    const after: Evaluation[] = [];
    await make(model, {
      config: { ...cfg, primaryAccountId: undefined },
      onEvaluation: (e) => after.push(e),
    }).handle(ev('after'), {});
    expect(after).toHaveLength(0);
  });

  it('a detected unknown person: would open an intruder incident', async () => {
    const r = await make(fakeModel([{ class: 'person', confidence: 0.9 }], 'unknown', true)).handle(
      ev(),
      {},
    );
    expect(r).toMatchObject({
      kind: 'intruder',
      would: 'would open an intruder incident in front_yard at L1',
    });
  });

  it('a redelivered event is ignored (events table dedupe)', async () => {
    const p = make(fakeModel([], 'benign'));
    await p.handle(ev('dup'), {});
    expect(await p.handle(ev('dup'), {})).toBeUndefined();
    expect(decisions).toHaveLength(1);
  });

  it('kill switch: logged as killed, no Ring or model call', async () => {
    const model = fakeModel([], 'benign');
    const download = vi.fn(async () => frame);
    const r = await make(model, { killed: true, download }).handle(ev(), {});
    expect(r).toMatchObject({ kind: 'killed' });
    expect(download).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('no accepted frame: no_evidence with the last reason, no model call', async () => {
    const model = fakeModel([], 'benign');
    const r = await make(model, {
      download: async () => ({ ...frame, media_origin: 'snapshot' }),
    }).handle(ev(), {});
    expect(r).toMatchObject({ kind: 'no_evidence', reason: 'origin_snapshot' });
    expect(model).not.toHaveBeenCalled();
  });

  it('a model error is a reject, never an action', async () => {
    const model = vi.fn(async () => 'I cannot help with that.');
    const r = await make(model as never).handle(ev(), {});
    expect(r?.kind).toBe('reject');
    expect(r?.reason).toMatch(/^perception_model_error/);
  });

  it('with a 35 s wildlife window, an 18 s old armadillo frame is acted on but a person is not', async () => {
    const config = parsePipelineConfig({ ...cfg, wildlifeMaxEvidenceAgeMs: 35_000 });
    const slowly = (m: ReturnType<typeof fakeModel>) =>
      vi.fn(async (c: ContentBlock[]) => {
        t += 9000;
        return m(c);
      }) as never;
    const armadillo = fakeModel([{ class: 'armadillo', confidence: 0.93 }], 'nuisance');
    expect((await make(slowly(armadillo), { config }).handle(ev('w1'), {}))?.kind).toBe('wildlife');
    const person = fakeModel([{ class: 'person', confidence: 0.95 }], 'unknown', true);
    const r = await make(slowly(person), { config }).handle(ev('p1'), {});
    expect(r?.reason).toMatch(/^stale_evidence_\d+ms_intruder$/);
  });

  it('the wildlife window is bounded in code: under 15 s or over 40 s is refused', () => {
    expect(() => parsePipelineConfig({ ...cfg, wildlifeMaxEvidenceAgeMs: 41_000 })).toThrow(
      /wildlifeMaxEvidenceAgeMs/,
    );
    expect(() => parsePipelineConfig({ ...cfg, wildlifeMaxEvidenceAgeMs: 10_000 })).toThrow(
      /wildlifeMaxEvidenceAgeMs/,
    );
  });

  it('evidence older than 15 s when the decision is reached is rejected, not acted on', async () => {
    const model = fakeModel([{ class: 'armadillo', confidence: 0.93 }], 'nuisance');
    const slow = vi.fn(async (c: ContentBlock[]) => {
      t += 9000; // each model call takes 9 s
      return model(c);
    });
    const r = await make(slow as never).handle(ev(), {});
    expect(r?.kind).toBe('reject');
    expect(r?.reason).toMatch(/^stale_evidence_\d+ms_wildlife$/);
    expect(saved).toEqual([]);
  });

  it('a second event on the same camera while one runs is logged as camera_busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = make(fakeModel([], 'benign'), {
      download: async () => {
        await gate;
        return frame;
      },
    });
    const first = p.handle(ev('a'), {});
    const second = await p.handle(ev('b'), {});
    expect(second).toMatchObject({ kind: 'log', reason: 'camera_busy' });
    release();
    await first;
  });

  it('refuses a config that is not a dry run', () => {
    expect(() => parsePipelineConfig({ ...cfg, dryRun: false })).toThrow(/dryRun must be true/);
  });
});
