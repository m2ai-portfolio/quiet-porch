// Why a frame was judged as it was, for the private run journal of a bounded run only.
// Built from the raw parsed model output, so every field is re-checked here: fixed enums,
// finite numbers, booleans, and short sanitized strings. Never image bytes or base64.
import { SUBJECT_CLASSES, type SubjectClass } from './perception.ts';
import { VERDICTS, type Verdict } from './critique.ts';

export const REASON_MAX_CHARS = 160;
export const REASON_MAX_ITEMS = 5;
// Longer model strings are cut before any pattern runs, so work stays bounded.
const INPUT_MAX_CHARS = 2000;

// Tabs and line breaks become spaces, so words they separated stay apart.
const BREAK = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
// Other C0/C1 controls plus zero-width and bidirectional overrides that can disguise a line.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const URL = /\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S*|\bdata:\S*/gi;
// Base64, hex digests, dotted JWTs and API keys: any 24+ character run of key-like characters,
// or an AWS access key id.
const TOKEN = /[A-Za-z\d+/=_.-]{24,}|\bA[KS]IA[A-Z\d]{16}\b/g;

export function sanitizeReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value
    .slice(0, INPUT_MAX_CHARS)
    .replace(BREAK, ' ')
    .replace(CONTROL, '')
    .replace(URL, '[redacted]')
    .replace(TOKEN, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return;
  // Cut by code point so a surrogate pair is never split.
  return Array.from(text).slice(0, REASON_MAX_CHARS).join('');
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  // Data properties only: a getter on hostile input is never invoked.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

export interface PerceptionReasons {
  person_present?: boolean;
  activity?: string;
  subjects: { class: SubjectClass; confidence: number }[];
  night_ir?: boolean;
}

export interface CritiqueReasons {
  verdict?: Verdict;
  person_present?: boolean;
  reasons: string[];
}

export function perceptionReasons(raw: unknown): PerceptionReasons {
  const list = own(raw, 'subjects');
  const subjects: PerceptionReasons['subjects'] = [];
  for (const s of Array.isArray(list) ? list.slice(0, 50) : []) {
    if (subjects.length >= REASON_MAX_ITEMS) break;
    const cls = own(s, 'class'),
      confidence = own(s, 'confidence');
    if (
      SUBJECT_CLASSES.includes(cls as SubjectClass) &&
      typeof confidence === 'number' &&
      confidence >= 0 &&
      confidence <= 1
    )
      subjects.push({ class: cls as SubjectClass, confidence });
  }
  return {
    person_present: bool(own(raw, 'person_present')),
    activity: sanitizeReason(own(raw, 'activity')),
    subjects,
    night_ir: bool(own(raw, 'night_ir')),
  };
}

export function critiqueReasons(raw: unknown): CritiqueReasons {
  const verdict = own(raw, 'verdict');
  const list = own(raw, 'reasons');
  const reasons: string[] = [];
  for (const r of Array.isArray(list) ? list.slice(0, 50) : []) {
    if (reasons.length >= REASON_MAX_ITEMS) break;
    const text = sanitizeReason(r);
    if (text !== undefined) reasons.push(text);
  }
  return {
    verdict: VERDICTS.includes(verdict as Verdict) ? (verdict as Verdict) : undefined,
    person_present: bool(own(raw, 'person_present')),
    reasons,
  };
}

// The journal fields for one judgement. Each half is computed independently, so a hostile
// value in one model's output cannot remove the other's reasons.
export function judgementReasons(judgement: { perception?: unknown; critique?: unknown }) {
  const safe = <T>(f: () => T) => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  return {
    perception: safe(() => perceptionReasons(judgement.perception)),
    critique: safe(() => critiqueReasons(judgement.critique)),
  };
}
