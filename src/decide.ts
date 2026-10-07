// Profile selection (plan v7 section 3), pure and deterministic. The order of the checks is
// the safety argument:
//   1. invalid or contradictory evidence -> reject (no action);
//   2. any uncertain person evidence -> log (no action, no notification);
//   3. critique benign or uncertain -> log, whatever the perception confidence;
//   4. a detected person can only reach the intruder profile, never wildlife, and only in
//      mode away or night or inside the night window (a daytime visitor in mode home is
//      logged: Matthew, 2026-10-07);
//   5. wildlife needs no person signal, a configured species >= 0.80, verdict exactly
//      "nuisance", and the night window.
import type { Critique } from './critique.ts';
import {
  nuisanceCandidate,
  personEvidence,
  type Perception,
  type Validated,
} from './perception.ts';

export type Decision =
  | { kind: 'reject'; reason: string }
  | { kind: 'log'; reason: string }
  | { kind: 'intruder'; reason: string }
  | { kind: 'wildlife'; species: string; reason: string };

// Whether the critique call is needed at all. Frames with nothing actionable are logged
// without spending a second model call.
export function needsCritique(p: Perception, nuisanceSpecies: string[]): boolean {
  const pe = personEvidence(p);
  if (pe.contradiction) return false;
  if (pe.signal) return pe.detected;
  return nuisanceCandidate(p, nuisanceSpecies) !== undefined;
}

export function decide(input: {
  perception: Validated<Perception>;
  critique?: Validated<Critique>;
  nuisanceSpecies: string[];
  inNightWindow: boolean;
  mode: 'home' | 'away' | 'night';
}): Decision {
  if (!input.perception.ok)
    return { kind: 'reject', reason: `perception_${input.perception.reason}` };
  const p = input.perception.value;
  const pe = personEvidence(p);
  if (pe.contradiction) return { kind: 'reject', reason: `contradiction_${pe.contradiction}` };
  if (pe.signal && !pe.detected) return { kind: 'log', reason: 'person_uncertain' };
  const species = pe.signal ? undefined : nuisanceCandidate(p, input.nuisanceSpecies);
  if (!pe.detected && !species) return { kind: 'log', reason: 'nothing_actionable' };

  if (!input.critique) return { kind: 'reject', reason: 'critique_missing' };
  if (!input.critique.ok) return { kind: 'reject', reason: `critique_${input.critique.reason}` };
  const c = input.critique.value;
  if (c.evidence_id !== p.evidence_id)
    return { kind: 'reject', reason: 'critique_evidence_mismatch' };
  if (c.verdict === 'benign') return { kind: 'log', reason: 'benign' };
  if (c.verdict === 'uncertain') return { kind: 'log', reason: 'critique_uncertain' };

  if (pe.detected) {
    if (c.verdict === 'unknown' || c.verdict === 'suspicious') {
      if (input.mode === 'home' && !input.inNightWindow)
        return { kind: 'log', reason: `person_${c.verdict}_daytime_home` };
      return { kind: 'intruder', reason: `person_${c.verdict}` };
    }
    return { kind: 'log', reason: `person_with_verdict_${c.verdict}` };
  }
  if (c.verdict !== 'nuisance') return { kind: 'log', reason: `species_with_verdict_${c.verdict}` };
  if (!input.inNightWindow) return { kind: 'log', reason: 'outside_night_window' };
  return { kind: 'wildlife', species: species!.class, reason: 'nuisance_at_night' };
}

// Minutes since local midnight in the configured time zone.
export function localMinutes(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return get('hour') * 60 + get('minute');
}

// Window given as "HH:MM"; it may wrap past midnight (20:00 to 06:30).
export function inWindow(epochMs: number, start: string, end: string, timeZone: string): boolean {
  const toMin = (s: string) => {
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    if (!m) throw new Error(`bad time ${s}`);
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const t = localMinutes(epochMs, timeZone);
  const a = toMin(start);
  const b = toMin(end);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
