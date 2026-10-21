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
  type DeliveryPolicy,
} from '../src/attended-delivery-policy.ts';
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
