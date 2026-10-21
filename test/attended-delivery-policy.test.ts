import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimDeliveryRun,
  deliveryClip,
  deliveryScopePath,
  deliverySpeaker,
  fingerprint,
  validateDeliveryPolicy,
  deliveryAuthorityActive,
  deliveryWindowOpen,
  deliveryTestConfig,
  type DeliveryPolicy,
} from '../src/attended-delivery-policy.ts';
import type { PipelineConfig } from '../src/pipeline.ts';
const dirs: string[] = [];
const directory = () => {
  const p = mkdtempSync(join(tmpdir(), 'qp-delivery-'));
  dirs.push(p);
  return p;
};
afterEach(() => {
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
const approved = (): DeliveryPolicy => ({
  operation: 'one-encounter-attended-delivery',
  approvalReference: 'owner-approved-fixture',
  expiresAt: 1000000 + 600000,
  scopePath: deliveryScopePath,
  modelId: 'global.anthropic.claude-sonnet-4-6',
  region: 'us-east-1',
  durationMs: 360000,
  wakeAdmissionMs: 300000,
  frames: 30,
  modelCalls: 60,
  telegramMessages: 1,
  speechPlays: 1,
  speakerFingerprint: deliverySpeaker,
  clip: deliveryClip,
  telegramChatFingerprint: fingerprint('fixture-chat'),
});
it('accepts only the exact current scope, recipient, route, outputs and bounds', () => {
  expect(() => validateDeliveryPolicy(approved(), 'fixture-chat', 1000000)).not.toThrow();
  for (const mutation of [
    { operation: 'output-disabled-yard-qualification' },
    { region: 'us-west-2' },
    { modelId: 'another-model' },
    { telegramMessages: 2 },
    { speechPlays: 2 },
    { frames: 31 },
    { modelCalls: 61 },
    { durationMs: 360001 },
    { wakeAdmissionMs: 300001 },
    { clip: 'another-clip' },
    { speakerFingerprint: 'another-speaker' },
    { expiresAt: 0 },
    { expiresAt: 2000000 },
    { approvalReference: 'pending' },
    { scopePath: '/other' },
  ])
    expect(() =>
      validateDeliveryPolicy({ ...approved(), ...mutation }, 'fixture-chat', 1000000),
    ).toThrow();
  expect(() => validateDeliveryPolicy(approved(), 'other-chat', 1000000)).toThrow();
});
it('consumes approval once and excludes competing attended runs', () => {
  const state = directory();
  const claim = claimDeliveryRun(state, 'owner-approved-fixture');
  expect(claim.owns()).toBe(true);
  expect(() => claimDeliveryRun(state, 'owner-approved-another')).toThrow();
  claim.release();
  expect(claim.owns()).toBe(false);
  expect(() => claimDeliveryRun(state, 'owner-approved-fixture')).toThrow();
  const next = claimDeliveryRun(state, 'owner-approved-another');
  next.release();
});
it('refuses the ongoing monitor and never releases a replacement lock', () => {
  const state = directory();
  writeFileSync(join(state, 'YARD-MONITOR.lock'), 'ongoing');
  expect(() => claimDeliveryRun(state, 'owner-approved-fixture')).toThrow();
  rmSync(join(state, 'YARD-MONITOR.lock'));
  const claim = claimDeliveryRun(state, 'owner-approved-fixture');
  writeFileSync(join(state, 'ATTENDED-TEST.lock'), 'replacement');
  claim.release();
  expect(readFileSync(join(state, 'ATTENDED-TEST.lock'), 'utf8')).toBe('replacement');
});

it('rejects malformed, premature, expired or overlong daylight authority', () => {
  const now = 1000000;
  const policy = { ...approved(), daylightTest: { startsAt: now, expiresAt: now + 360000 } };
  expect(() => validateDeliveryPolicy(policy, 'fixture-chat', now)).not.toThrow();
  for (const daylightTest of [
    null,
    {},
    { startsAt: NaN, expiresAt: now + 1 },
    { startsAt: now, expiresAt: Infinity },
    { startsAt: now + 1, expiresAt: now + 2 },
    { startsAt: now, expiresAt: now - 1 },
    { startsAt: now - 1, expiresAt: now },
    { startsAt: now, expiresAt: now + 360001 },
    { startsAt: now - 360000, expiresAt: now + 1 },
  ])
    expect(() =>
      validateDeliveryPolicy({ ...policy, daylightTest } as DeliveryPolicy, 'fixture-chat', now),
    ).toThrow();
  expect(() =>
    validateDeliveryPolicy({ ...policy, expiresAt: now + 60000 }, 'fixture-chat', now),
  ).toThrow();
});

it('requires explicit daylight authority, preserves config, and cannot continue into night after expiry', () => {
  const noon = Date.UTC(2026, 9, 21, 12);
  const cfg: PipelineConfig = {
    dryRun: true,
    zones: {},
    timezone: 'UTC',
    nightWindow: { start: '20:00', end: '06:30' },
    followUpProbe: false,
    wildlifeMaxEvidenceAgeMs: 35000,
    context: {
      mode: 'home',
      knownPets: ['fixture pet'],
      expectedVisitors: ['fixture delivery'],
      routines: ['fixture routine'],
      nuisanceSpecies: ['armadillo'],
    },
  };
  const night = Date.UTC(2026, 9, 21, 20);
  const ordinary = { ...approved(), expiresAt: night + 60000 };
  expect(deliveryWindowOpen(ordinary, cfg, noon)).toBe(false);
  expect(deliveryWindowOpen(ordinary, cfg, night)).toBe(true);
  expect(deliveryTestConfig(ordinary, cfg, noon)).toBe(cfg);
  const daylight = { ...ordinary, daylightTest: { startsAt: night - 60000, expiresAt: night } };
  const effective = deliveryTestConfig(daylight, cfg, night - 1000);
  expect(deliveryWindowOpen(daylight, cfg, night - 1000)).toBe(true);
  expect(effective).toEqual({ ...cfg, context: { ...cfg.context, mode: 'away' } });
  expect(cfg.context.mode).toBe('home');
  expect(deliveryAuthorityActive(daylight, night - 60001)).toBe(false);
  expect(deliveryAuthorityActive(daylight, night)).toBe(false);
  expect(deliveryWindowOpen(daylight, cfg, night)).toBe(false);
  expect(deliveryTestConfig(daylight, cfg, night)).toBe(cfg);
});
