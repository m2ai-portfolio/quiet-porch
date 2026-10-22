import { expect, it } from 'vitest';
import { perceptionPrompt } from '../src/perception.ts';

// The attended path asks for a brief perception result: no voice_slots, a short activity and
// one line of JSON. Output tokens set the speech budget there. The ongoing path is unchanged.
it('brief mode drops voice_slots, caps activity and asks for one line; default is unchanged', () => {
  const full = perceptionPrompt('ev_1');
  const brief = perceptionPrompt('ev_1', { brief: true });
  expect(full).toContain('voice_slots');
  expect(full).toContain('"activity": short string');
  expect(brief).not.toContain('voice_slots');
  expect(brief).toContain('"activity": string of at most 6 words');
  expect(brief).toContain('on one line');
  expect(brief).toContain('Never include identities or protected characteristics');
  expect(brief).toContain('"evidence_id": "ev_1"');
  expect(brief.length).toBeLessThan(full.length);
  expect(perceptionPrompt('ev_1', {})).toBe(full);
});
