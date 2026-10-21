import { expect, it } from 'vitest';
import { speakerVolumeAllowed, speakerVolumeReady } from '../src/speaker-volume.ts';

it('requires the owner-requested 100% for Anker readiness without changing other ceilings', () => {
  expect(speakerVolumeReady(1, '12b20969fc2c')).toBe(true);
  for (const level of [0, 0.36, 0.6, 0.99, 1.001, NaN])
    expect(speakerVolumeReady(level, '12b20969fc2c')).toBe(false);
  expect(speakerVolumeReady(0.6, 'other')).toBe(true);
});

it('permits 100% only for the owner-approved Anker and rejects amplification above it', () => {
  expect(speakerVolumeAllowed(0.37, '12b20969fc2c')).toBe(true);
  expect(speakerVolumeAllowed(1, '12b20969fc2c')).toBe(true);
  expect(speakerVolumeAllowed(1.001, '12b20969fc2c')).toBe(false);
});

it('preserves the 60% ceiling for every other speaker fingerprint', () => {
  for (const fingerprint of ['', 'other-speaker', '12b20969fc2d']) {
    expect(speakerVolumeAllowed(0.6, fingerprint)).toBe(true);
    expect(speakerVolumeAllowed(0.601, fingerprint)).toBe(false);
    expect(speakerVolumeAllowed(1, fingerprint)).toBe(false);
  }
});

it('rejects muted, negative and nonfinite readings for the approved speaker', () => {
  for (const volume of [0, -1, NaN, Infinity, -Infinity])
    expect(speakerVolumeAllowed(volume, '12b20969fc2c')).toBe(false);
});
