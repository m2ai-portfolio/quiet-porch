import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('runs the actual Pi guarded helper against offline clocks, locks and output fixtures', () => {
  const test = new URL('./guarded-speech.test.py', import.meta.url).pathname;
  expect(() => execFileSync('python3', [test], { encoding: 'utf8' })).not.toThrow();
});
