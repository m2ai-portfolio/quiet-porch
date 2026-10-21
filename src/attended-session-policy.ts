// Owner-approved policies for the two hands-off test modes. Both reuse the one-encounter
// pins (scope, route, speaker, clip, recipient) and its single-use approval ledger; neither
// widens any per-encounter limit, freshness gate or cooldown.
//   bounded-attended-session: one approval, at most 60 minutes and 3 encounters, one output.
//   labelled-delivery-replay: one recorded still through real judgement, Telegram and speaker,
//                             with no camera call, labelled REPLAY wherever it shows.
import {
  deliveryClip,
  deliveryRecoveryShapes,
  deliveryScopePath,
  deliverySpeaker,
  fingerprint,
} from './attended-delivery-policy.ts';
import { boundedYardLimits } from './bounded-yard.ts';
import type { PipelineConfig } from './pipeline.ts';
import type { RecoveryCause } from './fresh-judgement.ts';

export const sessionLimits = {
  maxDurationMs: 60 * 60000,
  maxStartNoticeMs: 15 * 60000,
  maxEncounters: 3,
  perEncounter: { frames: boundedYardLimits.frames, modelCalls: boundedYardLimits.modelCalls },
  totals: { frames: 90, modelCalls: 180, telegramMessages: 1, speechPlays: 1 },
} as const;
// A slot is one bounded-yard run: wake admission, encounter, drain. A slot starts only when
// it can finish before the session expires, so expiry never cuts an encounter short.
export const sessionSlotMs = boundedYardLimits.durationMs + boundedYardLimits.drainMs;

interface PinnedOutputs {
  approvalReference: string;
  scopePath: string;
  modelId: string;
  region: string;
  speakerFingerprint: string;
  clip: string;
  telegramChatFingerprint: string;
  speakerVolume?: number;
}

export interface SessionPolicy extends PinnedOutputs {
  operation: 'bounded-attended-session';
  startsAt: number;
  expiresAt: number;
  maxEncounters: number;
  perEncounter: { frames: number; modelCalls: number };
  sessionTotals: {
    frames: number;
    modelCalls: number;
    telegramMessages: number;
    speechPlays: number;
  };
  // Sessions are supervised office tests only; the camera binding and zone stay unchanged.
  testSetting: 'office';
  recovery?: { newFrameRecoveries: 1; causes: RecoveryCause[] };
}

// Real Ring person stills kept for offline tests, never a live claim.
export const replayFixtureRoot = '/home/apexaipc/.local/state/quiet-porch/fixtures/set1';
export const replayFixtures = [
  'ring-door-person',
  'ring-person-garden',
  'ring-person-car',
] as const;
export type ReplayFixture = (typeof replayFixtures)[number];

export interface ReplayPolicy extends PinnedOutputs {
  operation: 'labelled-delivery-replay';
  expiresAt: number;
  fixture: ReplayFixture;
  fixtureSha256: string; // exact bytes of <fixture>/frame.jpg
  frames: number;
  modelCalls: number;
  telegramMessages: number;
  speechPlays: number;
}

const exactly = (value: unknown, expected: unknown) =>
  JSON.stringify(value) === JSON.stringify(expected);

function pinsHold(policy: PinnedOutputs, chat: string) {
  return (
    /^owner-approved-[A-Za-z0-9-]{1,80}$/.test(policy.approvalReference) &&
    policy.scopePath === deliveryScopePath &&
    policy.modelId === 'global.anthropic.claude-sonnet-4-6' &&
    policy.region === 'us-east-1' &&
    policy.speakerFingerprint === deliverySpeaker &&
    policy.clip === deliveryClip &&
    !!chat &&
    policy.telegramChatFingerprint === fingerprint(chat) &&
    (policy.speakerVolume === undefined ||
      (typeof policy.speakerVolume === 'number' &&
        Number.isFinite(policy.speakerVolume) &&
        policy.speakerVolume > 0 &&
        policy.speakerVolume <= 1 &&
        Number(policy.speakerVolume.toFixed(2)) === policy.speakerVolume))
  );
}

export function validateSessionPolicy(policy: SessionPolicy, chat: string, now = Date.now()) {
  if (
    policy.operation !== 'bounded-attended-session' ||
    !pinsHold(policy, chat) ||
    !Number.isFinite(policy.startsAt) ||
    !Number.isFinite(policy.expiresAt) ||
    policy.startsAt > now + sessionLimits.maxStartNoticeMs ||
    policy.expiresAt <= now ||
    policy.expiresAt - policy.startsAt < sessionSlotMs ||
    policy.expiresAt - policy.startsAt > sessionLimits.maxDurationMs ||
    policy.maxEncounters !== sessionLimits.maxEncounters ||
    !exactly(policy.perEncounter, sessionLimits.perEncounter) ||
    !exactly(policy.sessionTotals, sessionLimits.totals) ||
    policy.testSetting !== 'office' ||
    (policy.recovery !== undefined &&
      !deliveryRecoveryShapes.some((shape) => exactly(policy.recovery, shape)))
  )
    throw new Error('invalid_or_expired_session_policy');
}

export function sessionAuthorityActive(policy: SessionPolicy, now = Date.now()) {
  return now >= policy.startsAt && now < policy.expiresAt;
}

// Away mode and the office note exist in memory only while the session is active.
export function sessionTestConfig(
  policy: SessionPolicy,
  cfg: PipelineConfig,
  now = Date.now(),
): PipelineConfig {
  if (!sessionAuthorityActive(policy, now)) return cfg;
  return { ...cfg, context: { ...cfg.context, mode: 'away', testSetting: 'office' } };
}

export function sessionAlertText(id: string, encounter: number, maxEncounters: number) {
  return `Quiet Porch supervised OFFICE session ${id}, encounter ${encounter} of ${maxEncounters}: person observed by the test camera, temporarily in the office (configured zone: front yard). The session ends after this alert; automatic stop is enabled.`;
}

export function validateReplayPolicy(policy: ReplayPolicy, chat: string, now = Date.now()) {
  if (
    policy.operation !== 'labelled-delivery-replay' ||
    !pinsHold(policy, chat) ||
    !Number.isFinite(policy.expiresAt) ||
    policy.expiresAt <= now ||
    policy.expiresAt > now + 15 * 60000 ||
    !replayFixtures.includes(policy.fixture) ||
    !/^[a-f0-9]{64}$/.test(policy.fixtureSha256) ||
    policy.frames !== boundedYardLimits.frames ||
    policy.modelCalls !== boundedYardLimits.modelCalls ||
    policy.telegramMessages !== 1 ||
    policy.speechPlays !== 1
  )
    throw new Error('invalid_or_expired_replay_policy');
}

export function replayAuthorityActive(policy: ReplayPolicy, now = Date.now()) {
  return now < policy.expiresAt;
}

// A recorded yard still is judged as the configured zone in away mode; no office note.
export function replayTestConfig(
  policy: ReplayPolicy,
  cfg: PipelineConfig,
  now = Date.now(),
): PipelineConfig {
  if (!replayAuthorityActive(policy, now)) return cfg;
  return { ...cfg, context: { ...cfg.context, mode: 'away' } };
}

export function replayAlertText(fixture: ReplayFixture, id: string) {
  return `REPLAY of ${fixture} (not live): Quiet Porch labelled delivery replay ${id}. A recorded still frame was judged now; no camera was used. Automatic stop is enabled.`;
}
