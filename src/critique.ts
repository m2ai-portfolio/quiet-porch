// Critique (plan v7 section 3). Text only: it weighs the validated perception against the
// household context and returns one verdict. It never sees or decides actions.
import type { Perception, Validated } from './perception.ts';

export const VERDICTS = ['benign', 'uncertain', 'unknown', 'suspicious', 'nuisance'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface HouseholdContext {
  mode: 'home' | 'away' | 'night';
  knownPets: string[];
  expectedVisitors: string[];
  routines: string[];
  nuisanceSpecies: string[];
  // Set in memory only by an approved one-shot office test, never by household config.
  testSetting?: 'office';
}

export interface Critique {
  evidence_id: string;
  verdict: Verdict;
  reasons: string[];
}

export function critiquePrompt(
  p: Perception,
  ctx: HouseholdContext,
  zone: string,
  localTime: string,
): string {
  return [
    'You are the critique step of a home security system. Judge ONE camera observation against',
    'the household context. You do not choose actions.',
    `Zone: ${zone}. Local time: ${localTime}. Mode: ${ctx.mode}.`,
    `Known pets: ${ctx.knownPets.join('; ') || 'none'}.`,
    `Expected visitors/deliveries: ${ctx.expectedVisitors.join('; ') || 'none'}.`,
    `Routines: ${ctx.routines.join('; ') || 'none'}.`,
    `Nuisance species: ${ctx.nuisanceSpecies.join(', ') || 'none'}.`,
    `Observation: ${JSON.stringify(p)}`,
    'Verdicts: "benign" (household member, known pet, expected visitor, delivery, passing car,',
    'nothing of note); "unknown" (a person who does not match the context); "suspicious" (a',
    'person behaving like a threat: lingering, trying doors, hiding); "nuisance" (a nuisance',
    'species from the list, not a known pet); "uncertain" (you cannot decide).',
    `Return ONLY a JSON object: {"evidence_id": "${p.evidence_id}", "verdict": one of`,
    `${VERDICTS.map((v) => `"${v}"`).join('|')}, "reasons": [short strings]}`,
  ].join('\n');
}

export function validateCritique(raw: unknown, evidenceId: string): Validated<Critique> {
  const o = raw as Partial<Critique> | null;
  if (!o || typeof o !== 'object') return { ok: false, reason: 'not_object' };
  if (o.evidence_id !== evidenceId) return { ok: false, reason: 'evidence_id_mismatch' };
  if (!VERDICTS.includes(o.verdict as Verdict)) return { ok: false, reason: 'bad_verdict' };
  if (!Array.isArray(o.reasons) || o.reasons.some((r) => typeof r !== 'string')) {
    return { ok: false, reason: 'bad_reasons' };
  }
  return { ok: true, value: o as Critique };
}
