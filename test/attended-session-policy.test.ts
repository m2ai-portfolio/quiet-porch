import { expect, it } from 'vitest';
import {
  deliveryClip,
  deliveryScopePath,
  deliverySpeaker,
  fingerprint,
  validateDeliveryPolicy,
  type DeliveryPolicy,
} from '../src/attended-delivery-policy.ts';
import {
  replayAlertText,
  replayAuthorityActive,
  replayTestConfig,
  sessionAlertText,
  sessionAuthorityActive,
  sessionSlotMs,
  sessionTestConfig,
  validateReplayPolicy,
  validateSessionPolicy,
  type ReplayPolicy,
  type SessionPolicy,
} from '../src/attended-session-policy.ts';
import type { PipelineConfig } from '../src/pipeline.ts';

const now = 1_000_000;
const pins = {
  approvalReference: 'owner-approved-fixture',
  scopePath: deliveryScopePath,
  modelId: 'global.anthropic.claude-sonnet-4-6',
  region: 'us-east-1',
  speakerFingerprint: deliverySpeaker,
  clip: deliveryClip,
  telegramChatFingerprint: fingerprint('fixture-chat'),
};
const session = (): SessionPolicy => ({
  ...pins,
  operation: 'bounded-attended-session',
  startsAt: now + 5 * 60000,
  expiresAt: now + 65 * 60000,
  maxEncounters: 3,
  perEncounter: { frames: 30, modelCalls: 60 },
  sessionTotals: { frames: 90, modelCalls: 180, telegramMessages: 1, speechPlays: 1 },
  testSetting: 'office',
  speakerVolume: 0.36,
  recovery: { newFrameRecoveries: 1, causes: ['model_unavailable_503', 'model_result_stale'] },
});
const replay = (): ReplayPolicy => ({
  ...pins,
  operation: 'labelled-delivery-replay',
  expiresAt: now + 10 * 60000,
  fixture: 'ring-door-person',
  fixtureSha256: 'a'.repeat(64),
  frames: 30,
  modelCalls: 60,
  telegramMessages: 1,
  speechPlays: 1,
  speakerVolume: 0.36,
});
const cfg = {
  dryRun: true,
  zones: {},
  timezone: 'UTC',
  nightWindow: { start: '20:00', end: '06:30' },
  context: { mode: 'home', knownPets: [], expectedVisitors: [], routines: [], nuisanceSpecies: [] },
} as unknown as PipelineConfig;

it('accepts a session at every bound and rejects one step past each', () => {
  expect(() => validateSessionPolicy(session(), 'fixture-chat', now)).not.toThrow();
  const atLimits: Partial<SessionPolicy>[] = [
    { startsAt: now + 15 * 60000, expiresAt: now + 75 * 60000 }, // 15 min notice, 60 min long
    { startsAt: now - 1000, expiresAt: now - 1000 + sessionSlotMs }, // already started, one slot
    { speakerVolume: undefined },
    { recovery: undefined },
  ];
  for (const change of atLimits)
    expect(() =>
      validateSessionPolicy({ ...session(), ...change }, 'fixture-chat', now),
    ).not.toThrow();
  const pastLimits: Partial<SessionPolicy>[] = [
    { operation: 'one-encounter-attended-delivery' as never },
    { startsAt: now + 15 * 60000 + 1, expiresAt: now + 75 * 60000 + 1 },
    { expiresAt: now + 65 * 60000 + 1 }, // 60 min + 1 ms
    { startsAt: now - 1000, expiresAt: now - 1001 + sessionSlotMs }, // room for no slot
    { startsAt: now - 60 * 60000, expiresAt: now }, // expired, otherwise valid length
    { startsAt: Number.NaN },
    { maxEncounters: 4 },
    { perEncounter: { frames: 31, modelCalls: 60 } },
    { perEncounter: { frames: 30, modelCalls: 61 } },
    { sessionTotals: { frames: 91, modelCalls: 180, telegramMessages: 1, speechPlays: 1 } },
    { sessionTotals: { frames: 90, modelCalls: 181, telegramMessages: 1, speechPlays: 1 } },
    { sessionTotals: { frames: 90, modelCalls: 180, telegramMessages: 2, speechPlays: 1 } },
    { sessionTotals: { frames: 90, modelCalls: 180, telegramMessages: 1, speechPlays: 2 } },
    { testSetting: undefined as never },
    { speakerVolume: 1.01 },
    { speakerVolume: 0.365 },
    { recovery: { newFrameRecoveries: 1, causes: ['model_result_stale'] } },
    { approvalReference: 'pending' },
    { region: 'us-west-2' },
    { modelId: 'another-model' },
    { clip: 'another-clip' },
    { speakerFingerprint: 'another-speaker' },
    { scopePath: '/tmp/scope.json' },
    { telegramChatFingerprint: fingerprint('another-chat') },
  ];
  for (const change of pastLimits)
    expect(
      () => validateSessionPolicy({ ...session(), ...change }, 'fixture-chat', now),
      JSON.stringify(change),
    ).toThrow('invalid_or_expired_session_policy');
  expect(() => validateSessionPolicy(session(), '', now)).toThrow();
});

it('session, replay and one-encounter policies never validate as one another', () => {
  expect(() => validateReplayPolicy(session() as never, 'fixture-chat', now)).toThrow();
  expect(() => validateSessionPolicy(replay() as never, 'fixture-chat', now)).toThrow();
  expect(() => validateDeliveryPolicy(session() as never, 'fixture-chat', now)).toThrow();
  expect(() => validateDeliveryPolicy(replay() as never, 'fixture-chat', now)).toThrow();
  const oneShot = { ...pins, operation: 'one-encounter-attended-delivery' } as DeliveryPolicy;
  expect(() => validateSessionPolicy(oneShot as never, 'fixture-chat', now)).toThrow();
  expect(() => validateReplayPolicy(oneShot as never, 'fixture-chat', now)).toThrow();
});

it('session authority and the in-memory away/office context exist only inside the window', () => {
  const p = session();
  expect(sessionAuthorityActive(p, p.startsAt - 1)).toBe(false);
  expect(sessionAuthorityActive(p, p.startsAt)).toBe(true);
  expect(sessionAuthorityActive(p, p.expiresAt - 1)).toBe(true);
  expect(sessionAuthorityActive(p, p.expiresAt)).toBe(false);
  expect(sessionTestConfig(p, cfg, p.startsAt - 1)).toBe(cfg);
  expect(sessionTestConfig(p, cfg, p.expiresAt)).toBe(cfg);
  const active = sessionTestConfig(p, cfg, p.startsAt);
  expect(active.context).toMatchObject({ mode: 'away', testSetting: 'office' });
  expect(cfg.context.mode).toBe('home'); // never written back
  expect(sessionAlertText('t1', 2, 3)).toMatch(/OFFICE session t1, encounter 2 of 3/);
});

it('accepts a replay at its bounds and rejects one step past each', () => {
  expect(() => validateReplayPolicy(replay(), 'fixture-chat', now)).not.toThrow();
  for (const fixture of ['ring-person-garden', 'ring-person-car'] as const)
    expect(() => validateReplayPolicy({ ...replay(), fixture }, 'fixture-chat', now)).not.toThrow();
  expect(() =>
    validateReplayPolicy({ ...replay(), expiresAt: now + 15 * 60000 }, 'fixture-chat', now),
  ).not.toThrow();
  const pastLimits: Partial<ReplayPolicy>[] = [
    { expiresAt: now + 15 * 60000 + 1 },
    { expiresAt: now },
    { fixture: 'dog-yard' as never },
    { fixture: '../ring-door-person' as never },
    { fixtureSha256: 'A'.repeat(64) },
    { fixtureSha256: 'a'.repeat(63) },
    { frames: 31 },
    { modelCalls: 61 },
    { telegramMessages: 2 },
    { speechPlays: 2 },
    { speakerVolume: 0 },
    { approvalReference: 'owner-approved-' },
    { clip: 'another-clip' },
    { telegramChatFingerprint: fingerprint('another-chat') },
  ];
  for (const change of pastLimits)
    expect(
      () => validateReplayPolicy({ ...replay(), ...change }, 'fixture-chat', now),
      JSON.stringify(change),
    ).toThrow('invalid_or_expired_replay_policy');
});

it('replay authority ends at expiry and every replay alert says REPLAY and not live', () => {
  const p = replay();
  expect(replayAuthorityActive(p, p.expiresAt - 1)).toBe(true);
  expect(replayAuthorityActive(p, p.expiresAt)).toBe(false);
  expect(replayTestConfig(p, cfg, p.expiresAt)).toBe(cfg);
  const active = replayTestConfig(p, cfg, now);
  expect(active.context.mode).toBe('away');
  expect(active.context.testSetting).toBeUndefined();
  expect(replayAlertText('ring-door-person', 'r1')).toMatch(
    /^REPLAY of ring-door-person \(not live\):.*no camera was used/,
  );
});
