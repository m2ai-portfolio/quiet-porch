// Perception (plan v7 section 3). Bedrock describes the frame; everything that matters for
// safety is derived here, deterministically, from the validated output. The model's evidence_id
// must echo ours, and person presence is computed from all person evidence, never trusted alone.

export const SUBJECT_CLASSES = [
  'person',
  'armadillo',
  'cat',
  'dog',
  'opossum',
  'raccoon',
  'deer',
  'vehicle',
  'other',
] as const;
export type SubjectClass = (typeof SUBJECT_CLASSES)[number];

export const PERSON_SIGNAL_MIN = 0.3;
export const PERSON_DETECTED_MIN = 0.8;
export const SPECIES_MIN = 0.8;

export interface Subject {
  class: SubjectClass;
  confidence: number;
}

export interface Perception {
  evidence_id: string;
  subjects: Subject[];
  person_present: boolean;
  activity: string;
  night_ir: boolean;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

export function perceptionPrompt(evidenceId: string): string {
  return [
    'You are the perception step of a home security system. Describe only what is visible in',
    'this single doorbell/yard camera frame. Do not guess identities.',
    `Return ONLY a JSON object with exactly these keys:`,
    `{"evidence_id": "${evidenceId}",`,
    ` "subjects": [{"class": one of ${SUBJECT_CLASSES.map((c) => `"${c}"`).join('|')},`,
    '               "confidence": number 0..1}],',
    ' "person_present": boolean,',
    ' "activity": short string,',
    ' "night_ir": boolean (true if the frame is a grayscale infrared night image)}',
    'List every person, animal and vehicle you can see, one entry each. Use an empty subjects',
    'array if there is nothing. Use "other" for an animal not in the list.',
  ].join('\n');
}

export function validatePerception(raw: unknown, evidenceId: string): Validated<Perception> {
  const o = raw as Partial<Perception> | null;
  if (!o || typeof o !== 'object') return { ok: false, reason: 'not_object' };
  if (o.evidence_id !== evidenceId) return { ok: false, reason: 'evidence_id_mismatch' };
  if (!Array.isArray(o.subjects)) return { ok: false, reason: 'subjects_not_array' };
  for (const s of o.subjects) {
    if (!s || !SUBJECT_CLASSES.includes(s.class)) return { ok: false, reason: 'bad_subject_class' };
    if (typeof s.confidence !== 'number' || !(s.confidence >= 0 && s.confidence <= 1)) {
      return { ok: false, reason: 'bad_subject_confidence' };
    }
  }
  if (typeof o.person_present !== 'boolean') return { ok: false, reason: 'bad_person_present' };
  if (typeof o.night_ir !== 'boolean') return { ok: false, reason: 'bad_night_ir' };
  if (typeof o.activity !== 'string') return { ok: false, reason: 'bad_activity' };
  return { ok: true, value: o as Perception };
}

export interface PersonEvidence {
  signal: boolean; // any credible sign of a person
  detected: boolean; // a person at >= PERSON_DETECTED_MIN
  maxConfidence: number;
  contradiction?: string;
}

export function personEvidence(p: Perception): PersonEvidence {
  const people = p.subjects.filter((s) => s.class === 'person');
  const maxConfidence = people.reduce((m, s) => Math.max(m, s.confidence), 0);
  const credible = maxConfidence >= PERSON_SIGNAL_MIN;
  let contradiction: string | undefined;
  if (!p.person_present && credible) contradiction = 'person_subject_but_person_present_false';
  if (p.person_present && people.length === 0) contradiction = 'person_present_without_subject';
  return {
    signal: p.person_present || credible,
    detected: maxConfidence >= PERSON_DETECTED_MIN,
    maxConfidence,
    contradiction,
  };
}

// The highest-confidence configured nuisance species at or above SPECIES_MIN, if any.
export function nuisanceCandidate(p: Perception, species: string[]): Subject | undefined {
  return p.subjects
    .filter((s) => species.includes(s.class) && s.confidence >= SPECIES_MIN)
    .sort((a, b) => b.confidence - a.confidence)[0];
}
