import { describe, expect, it } from 'vitest';
import { validateCritique, type Critique } from '../src/critique.ts';
import { decide, inWindow, needsCritique } from '../src/decide.ts';
import { personEvidence, validatePerception, type Perception } from '../src/perception.ts';

const EV = 'ev_1';
const perc = (subjects: Perception['subjects'], person_present = false): Perception => ({
  evidence_id: EV,
  subjects,
  person_present,
  activity: 'x',
  night_ir: true,
});
const crit = (verdict: Critique['verdict']): Critique => ({
  evidence_id: EV,
  verdict,
  reasons: [],
});
const run = (
  p: Perception,
  c?: Critique['verdict'],
  night = true,
  mode: 'home' | 'away' | 'night' = 'home',
) =>
  decide({
    perception: { ok: true, value: p },
    critique: c ? { ok: true, value: crit(c) } : undefined,
    nuisanceSpecies: ['armadillo'],
    inNightWindow: night,
    mode,
  });

describe('decide: people', () => {
  it('a 0.80 person with unknown or suspicious reaches the intruder profile', () => {
    expect(run(perc([{ class: 'person', confidence: 0.8 }], true), 'unknown').kind).toBe(
      'intruder',
    );
    expect(run(perc([{ class: 'person', confidence: 0.95 }], true), 'suspicious').kind).toBe(
      'intruder',
    );
  });

  it('a daytime unknown or suspicious person in mode home is logged, not L1', () => {
    const person = perc([{ class: 'person', confidence: 0.95 }], true);
    expect(run(person, 'unknown', false, 'home')).toEqual({
      kind: 'log',
      reason: 'person_unknown_daytime_home',
    });
    expect(run(person, 'suspicious', false, 'home')).toEqual({
      kind: 'log',
      reason: 'person_suspicious_daytime_home',
    });
  });

  it('the same daytime person reaches intruder in mode away or night', () => {
    const person = perc([{ class: 'person', confidence: 0.95 }], true);
    expect(run(person, 'unknown', false, 'away').kind).toBe('intruder');
    expect(run(person, 'unknown', false, 'night').kind).toBe('intruder');
  });

  it('a 0.65 person is uncertain: logged, whatever the critique says', () => {
    expect(run(perc([{ class: 'person', confidence: 0.65 }], true), 'suspicious')).toEqual({
      kind: 'log',
      reason: 'person_uncertain',
    });
  });

  it('critique benign or uncertain is log only', () => {
    expect(run(perc([{ class: 'person', confidence: 0.95 }], true), 'benign').kind).toBe('log');
    expect(run(perc([{ class: 'person', confidence: 0.95 }], true), 'uncertain')).toEqual({
      kind: 'log',
      reason: 'critique_uncertain',
    });
  });

  it('a detected person never reaches wildlife, even with an armadillo and a nuisance verdict', () => {
    const d = run(
      perc(
        [
          { class: 'person', confidence: 0.95 },
          { class: 'armadillo', confidence: 0.99 },
        ],
        true,
      ),
      'nuisance',
    );
    expect(d.kind).toBe('log');
  });
});

describe('decide: contradictions and bad evidence', () => {
  it('person 0.95 + armadillo 0.90 with person_present false is rejected (review F5 case)', () => {
    const d = run(
      perc([
        { class: 'person', confidence: 0.95 },
        { class: 'armadillo', confidence: 0.9 },
      ]),
      'nuisance',
    );
    expect(d).toEqual({
      kind: 'reject',
      reason: 'contradiction_person_subject_but_person_present_false',
    });
  });

  it('person_present true with no person subject is rejected', () => {
    expect(run(perc([{ class: 'cat', confidence: 0.9 }], true)).kind).toBe('reject');
  });

  it('invalid perception or critique is rejected, never acted on', () => {
    expect(
      decide({
        perception: { ok: false, reason: 'evidence_id_mismatch' },
        nuisanceSpecies: [],
        inNightWindow: true,
        mode: 'home',
      }),
    ).toEqual({ kind: 'reject', reason: 'perception_evidence_id_mismatch' });
    expect(
      decide({
        perception: { ok: true, value: perc([{ class: 'armadillo', confidence: 0.9 }]) },
        critique: { ok: false, reason: 'bad_verdict' },
        nuisanceSpecies: ['armadillo'],
        inNightWindow: true,
        mode: 'home',
      }).kind,
    ).toBe('reject');
  });

  it('a critique that echoes another evidence_id is rejected', () => {
    expect(
      decide({
        perception: { ok: true, value: perc([{ class: 'armadillo', confidence: 0.9 }]) },
        critique: { ok: true, value: { ...crit('nuisance'), evidence_id: 'ev_other' } },
        nuisanceSpecies: ['armadillo'],
        inNightWindow: true,
        mode: 'home',
      }).kind,
    ).toBe('reject');
  });
});

describe('decide: wildlife', () => {
  const armadillo = (c: number) => perc([{ class: 'armadillo', confidence: c }]);

  it('armadillo 0.80, nuisance, at night: wildlife', () => {
    expect(run(armadillo(0.8), 'nuisance')).toEqual({
      kind: 'wildlife',
      species: 'armadillo',
      reason: 'nuisance_at_night',
    });
  });

  it('armadillo 0.79 is not actionable and skips critique', () => {
    expect(needsCritique(armadillo(0.79), ['armadillo'])).toBe(false);
    expect(run(armadillo(0.79))).toEqual({ kind: 'log', reason: 'nothing_actionable' });
  });

  it('armadillo 0.95 with a benign critique gives no action (review F9 case)', () => {
    expect(run(armadillo(0.95), 'benign')).toEqual({ kind: 'log', reason: 'benign' });
  });

  it('armadillo with unknown or suspicious is logged, only nuisance acts', () => {
    expect(run(armadillo(0.95), 'unknown').kind).toBe('log');
  });

  it('outside the night window it is logged', () => {
    expect(run(armadillo(0.95), 'nuisance', false)).toEqual({
      kind: 'log',
      reason: 'outside_night_window',
    });
  });

  it('a species not configured as nuisance is not actionable', () => {
    expect(run(perc([{ class: 'cat', confidence: 0.99 }]))).toEqual({
      kind: 'log',
      reason: 'nothing_actionable',
    });
  });
});

describe('perception and critique validation', () => {
  const good = {
    evidence_id: EV,
    subjects: [{ class: 'cat', confidence: 0.5 }],
    person_present: false,
    activity: 'sitting',
    night_ir: false,
  };

  it('accepts a well-formed perception', () => {
    expect(validatePerception(good, EV).ok).toBe(true);
  });

  it.each([
    ['another evidence_id', { ...good, evidence_id: 'ev_2' }, 'evidence_id_mismatch'],
    [
      'an unknown class',
      { ...good, subjects: [{ class: 'dragon', confidence: 0.5 }] },
      'bad_subject_class',
    ],
    [
      'confidence above 1',
      { ...good, subjects: [{ class: 'cat', confidence: 1.2 }] },
      'bad_subject_confidence',
    ],
    ['a string person_present', { ...good, person_present: 'no' }, 'bad_person_present'],
    ['subjects missing', { ...good, subjects: undefined }, 'subjects_not_array'],
  ])('rejects %s', (_n, raw, reason) => {
    expect(validatePerception(raw, EV)).toEqual({ ok: false, reason });
  });

  it('person evidence: 0.30 is a signal, 0.80 is detected', () => {
    expect(personEvidence(perc([{ class: 'person', confidence: 0.3 }], true))).toMatchObject({
      signal: true,
      detected: false,
    });
    expect(personEvidence(perc([{ class: 'person', confidence: 0.29 }]))).toMatchObject({
      signal: false,
      detected: false,
    });
  });

  it('critique must use a known verdict and echo the evidence_id', () => {
    expect(validateCritique({ evidence_id: EV, verdict: 'nuisance', reasons: ['a'] }, EV).ok).toBe(
      true,
    );
    expect(validateCritique({ evidence_id: EV, verdict: 'hostile', reasons: [] }, EV)).toEqual({
      ok: false,
      reason: 'bad_verdict',
    });
    expect(validateCritique({ evidence_id: 'x', verdict: 'benign', reasons: [] }, EV)).toEqual({
      ok: false,
      reason: 'evidence_id_mismatch',
    });
  });
});

describe('night window', () => {
  // 2026-10-08 in America/Chicago (CDT, UTC-5).
  const at = (hhmm: string) => Date.parse(`2026-10-08T${hhmm}:00-05:00`);
  it.each([
    ['19:59', false],
    ['20:00', true],
    ['23:30', true],
    ['00:10', true],
    ['06:29', true],
    ['06:30', false],
    ['12:00', false],
  ])('%s is %s', (hhmm, inside) => {
    expect(inWindow(at(hhmm), '20:00', '06:30', 'America/Chicago')).toBe(inside);
  });
});
