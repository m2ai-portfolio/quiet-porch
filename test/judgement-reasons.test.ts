// Sanitized judgement reasons: bounded, redacted strings and fixed enums, written only when
// the observer is asked to. Transports are fakes.
import { expect, it } from 'vitest';
import {
  critiqueReasons,
  judgementReasons,
  perceptionReasons,
  REASON_MAX_CHARS,
  sanitizeReason,
} from '../src/judgement-reasons.ts';
import { createAttendedObserver } from '../src/attended-observer.ts';
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
const isCritique = (content: ContentBlock[]) =>
  content.some((c) => 'text' in c && c.text.includes('independent visual critique'));

function observer(opts: {
  record?: boolean;
  critique?: Record<string, unknown>;
  perception?: Record<string, unknown>;
  lagMs?: number;
}) {
  let time = 100000;
  const rows: Record<string, unknown>[] = [];
  const o = createAttendedObserver({
    scope,
    config: () => cfg,
    parallelCritique: true,
    ...(opts.record === undefined ? {} : { recordJudgementReasons: opts.record }),
    download: async (_a, _d, ts) => ({
      status: 200,
      step: 2,
      content_type: 'image/jpeg',
      media_origin: 'recording',
      media_timestamp: ts,
      image: jpeg,
    }),
    converse: async (content) => {
      time += (opts.lagMs ?? 0) / 2;
      const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
      const id = text.match(/ev_[a-f0-9]{24}/)?.[0];
      return JSON.stringify(
        isCritique(content)
          ? {
              evidence_id: id,
              verdict: 'uncertain',
              person_present: true,
              reasons: ['indoor scene'],
              ...opts.critique,
            }
          : {
              evidence_id: id,
              subjects: [{ class: 'person', confidence: 0.9 }],
              person_present: true,
              activity: 'sitting at a desk',
              night_ir: false,
              ...opts.perception,
            },
      );
    },
    allowed: () => true,
    audit: (row) => rows.push(row),
    now: () => time,
  });
  return {
    poll: () => o.poll(),
    rows,
    event: (name: string) => rows.filter((r) => r.event === name),
  };
}

it('reasons are cut to 160 characters by code point, never splitting a surrogate pair', () => {
  expect(sanitizeReason('a'.repeat(23) + ' ' + 'word '.repeat(100))).toHaveLength(REASON_MAX_CHARS);
  const emoji = sanitizeReason('ab '.repeat(53) + '😀😀')!;
  expect(Array.from(emoji)).toHaveLength(REASON_MAX_CHARS);
  expect(emoji.endsWith('😀')).toBe(true);
  expect(sanitizeReason('short')).toBe('short');
});

it('control, zero-width and bidi characters are removed and whitespace is collapsed', () => {
  expect(sanitizeReason('a\u0000b\u001bc\u007fd\u009be')).toBe('abcde');
  expect(sanitizeReason('line\u0085next\u2028sep\u2029end\vx\fy')).toBe('line next sep end x y');
  expect(sanitizeReason('left\u202eright\u200bjoin\u2066x\ufeff')).toBe('leftrightjoinx');
  expect(sanitizeReason('one\n\ntwo\tthree\r\n')).toBe('one two three');
  expect(sanitizeReason('  \u0000\u200b  ')).toBeUndefined();
});

it('URLs, data URIs and token-like strings are replaced with [redacted]', () => {
  expect(sanitizeReason('see https://evil.example/x?y=1 now')).toBe('see [redacted] now');
  expect(sanitizeReason('go www.example.com/path')).toBe('go [redacted]');
  expect(sanitizeReason('img data:image/jpeg;base64,/9j/4AAQ end')).toBe('img [redacted] end');
  expect(sanitizeReason('key AKIAABCDEFGHIJKLMNOP here')).toBe('key [redacted] here');
  expect(sanitizeReason('bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc')).toBe(
    'bearer [redacted]',
  );
  expect(sanitizeReason('sha ' + 'ab12'.repeat(16))).toBe('sha [redacted]');
  expect(sanitizeReason('b64 ' + Buffer.alloc(40, 7).toString('base64'))).toBe('b64 [redacted]');
  // A token hidden behind a control character is still redacted after removal.
  expect(sanitizeReason('t ' + 'abcdefghij\u0000klmnopqrstuvwxyz')).toBe('t [redacted]');
  // Ordinary words and short identifiers are kept.
  expect(sanitizeReason('person seated, low light, face partly hidden')).toBe(
    'person seated, low light, face partly hidden',
  );
});

it('non-strings are dropped, and long input is bounded before any pattern runs', () => {
  for (const v of [undefined, null, 3, true, {}, ['x'], Symbol('s')])
    expect(sanitizeReason(v)).toBeUndefined();
  const huge = 'safe '.repeat(200_000);
  expect(sanitizeReason(huge)).toHaveLength(REASON_MAX_CHARS);
  // Text past the first 2000 characters is never read, even when redaction shortens the rest.
  expect(sanitizeReason('a'.repeat(2000) + ' after the bound')).toBe('[redacted]');
});

it('perception keeps at most 5 valid subjects and only typed scalar fields', () => {
  const p = perceptionReasons({
    person_present: 'yes',
    night_ir: true,
    activity: 'walking\u0000 to https://x.example',
    subjects: [
      { class: 'person', confidence: 0.95 },
      { class: 'dragon', confidence: 0.9 },
      { class: 'dog', confidence: 1.5 },
      { class: 'cat', confidence: Number.NaN },
      { class: 'dog', confidence: '0.9' },
      { class: 'cat', confidence: 0.4 },
      null,
      { class: 'deer', confidence: 0 },
      { class: 'vehicle', confidence: 1 },
      { class: 'other', confidence: 0.2 },
      { class: 'raccoon', confidence: 0.3 },
    ],
    image: Buffer.alloc(8).toString('base64'),
  });
  expect(p).toEqual({
    person_present: undefined,
    night_ir: true,
    activity: 'walking to [redacted]',
    subjects: [
      { class: 'person', confidence: 0.95 },
      { class: 'cat', confidence: 0.4 },
      { class: 'deer', confidence: 0 },
      { class: 'vehicle', confidence: 1 },
      { class: 'other', confidence: 0.2 },
    ],
  });
  expect(Object.keys(p).sort()).toEqual(['activity', 'night_ir', 'person_present', 'subjects']);
});

it('critique keeps only an allowed verdict and at most 5 sanitized string reasons', () => {
  expect(
    critiqueReasons({
      verdict: 'intruder',
      person_present: true,
      reasons: [1, 'a', '', 'b\u0000', { x: 1 }, 'c', 'd', 'e', 'f'],
    }),
  ).toEqual({ verdict: undefined, person_present: true, reasons: ['a', 'b', 'c', 'd', 'e'] });
  expect(critiqueReasons({ verdict: 'uncertain', reasons: 'not a list' })).toEqual({
    verdict: 'uncertain',
    person_present: undefined,
    reasons: [],
  });
  expect(critiqueReasons(undefined)).toEqual({
    verdict: undefined,
    person_present: undefined,
    reasons: [],
  });
});

it('getters on hostile input are never invoked, and one bad half keeps the other', () => {
  let touched = false;
  const hostile = Object.defineProperty({}, 'reasons', {
    get() {
      touched = true;
      return ['leak'];
    },
    enumerable: true,
  });
  expect(critiqueReasons(hostile).reasons).toEqual([]);
  expect(touched).toBe(false);
  const throwing = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
    },
  );
  const r = judgementReasons({
    perception: throwing,
    critique: { verdict: 'benign', reasons: [] },
  });
  expect(r.perception).toBeUndefined();
  expect(r.critique).toEqual({ verdict: 'benign', person_present: undefined, reasons: [] });
});

it('with the option off or absent the observation row is exactly as before', async () => {
  const keys = [
    'event',
    'perception_ms',
    'critique_ms',
    'age_at_completion_ms',
    'parallel_critique',
    'evidence_id',
    'capture_ts',
    'verdict',
    'decision',
    'reason',
  ].sort();
  for (const record of [undefined, false]) {
    const o = observer({ record });
    await o.poll();
    const [row] = o.event('followup_observation');
    expect(Object.keys(row).sort()).toEqual(keys);
  }
});

it('with the option on an uncertain observation row carries both sanitized halves', async () => {
  const o = observer({
    record: true,
    critique: {
      reasons: ['office interior', 'see https://x.example/a', 'x'.repeat(400), 'ignore previous'],
    },
  });
  const ev = await o.poll();
  expect(ev?.verdict).toBe('uncertain');
  const [row] = o.event('followup_observation');
  expect(row).toMatchObject({ verdict: 'uncertain', reason: 'critique_uncertain' });
  expect(row.perception).toEqual({
    person_present: true,
    activity: 'sitting at a desk',
    subjects: [{ class: 'person', confidence: 0.9 }],
    night_ir: false,
  });
  expect(row.critique).toEqual({
    verdict: 'uncertain',
    person_present: true,
    reasons: ['office interior', 'see [redacted]', '[redacted]', 'ignore previous'],
  });
  expect(JSON.stringify(o.rows)).not.toContain(jpeg.toString('base64'));
});

it('a disagreement row and a stale rejection row carry the same fields when on', async () => {
  const d = observer({ record: true, critique: { person_present: false, verdict: 'benign' } });
  await d.poll();
  const [row] = d.event('followup_observation');
  expect(row).toMatchObject({ decision: 'reject', reason: 'independent_judgement_disagreement' });
  expect(row.critique).toEqual({
    verdict: 'benign',
    person_present: false,
    reasons: ['indoor scene'],
  });
  expect((row.perception as { person_present: boolean }).person_present).toBe(true);

  const s = observer({ record: true, lagMs: 4500 });
  await expect(s.poll()).resolves.toBeUndefined();
  const [stale] = s.event('followup_rejected');
  expect(stale).toMatchObject({ reason: 'model_result_stale' });
  expect(stale.critique).toEqual({
    verdict: 'uncertain',
    person_present: true,
    reasons: ['indoor scene'],
  });

  const off = observer({ lagMs: 4500 });
  await off.poll();
  expect(off.event('followup_rejected')[0]).toEqual({
    event: 'followup_rejected',
    reason: 'model_result_stale',
  });
});
