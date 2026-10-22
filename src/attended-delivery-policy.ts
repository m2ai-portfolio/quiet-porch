import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedYardLimits } from './bounded-yard.ts';
import { inWindow } from './decide.ts';
import type { RecoveryCause } from './fresh-judgement.ts';
import type { PipelineConfig } from './pipeline.ts';

export const deliveryScopePath =
  '/home/apexaipc/Documents/Codex/2026-10-12/task/quiet-porch-private/ongoing-yard-monitor/scope.private.json';
export const deliveryClip =
  'speech-6fa6f1f5966142279ab93f3b1fa91dc1dd98d210c47af2ae879f964df24cb6aa';
export const deliverySpeaker = '12b20969fc2c';
export interface DeliveryPolicy {
  operation: string;
  approvalReference: string;
  expiresAt: number;
  scopePath: string;
  modelId: string;
  region: string;
  durationMs: number;
  wakeAdmissionMs: number;
  frames: number;
  modelCalls: number;
  telegramMessages: number;
  speechPlays: number;
  speakerFingerprint: string;
  clip: string;
  telegramChatFingerprint: string;
  // An attended daytime test simulates away mode in memory only. It cannot turn
  // into ordinary night monitoring when this interval expires.
  daylightTest?: { startsAt: number; expiresAt: number };
  // A supervised office test labels policy, audit, critique context and Telegram. The
  // persistent camera binding and zone stay unchanged.
  testSetting?: 'office';
  // Office tests only: the exact speaker level readiness requires instead of 100%.
  speakerVolume?: number;
  // Exactly one recovery on a new frame, shared by the listed causes. Absent = none.
  recovery?: { newFrameRecoveries: 1; causes: RecoveryCause[] };
}
// The only accepted recovery shapes: the 503 cause alone, or 503 plus a too-old result.
export const deliveryRecoveryShapes = [
  { newFrameRecoveries: 1, causes: ['model_unavailable_503'] },
  { newFrameRecoveries: 1, causes: ['model_unavailable_503', 'model_result_stale'] },
] as const;
export function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
export function validateDeliveryPolicy(policy: DeliveryPolicy, chat: string, now = Date.now()) {
  const daylight = policy.daylightTest;
  if (
    policy.operation !== 'one-encounter-attended-delivery' ||
    !/^owner-approved-[A-Za-z0-9-]{1,80}$/.test(policy.approvalReference) ||
    !Number.isFinite(policy.expiresAt) ||
    policy.expiresAt <= now ||
    policy.expiresAt > now + 15 * 60000 ||
    policy.scopePath !== deliveryScopePath ||
    policy.modelId !== 'global.anthropic.claude-sonnet-4-6' ||
    policy.region !== 'us-east-1' ||
    policy.durationMs !== boundedYardLimits.durationMs ||
    policy.wakeAdmissionMs !== boundedYardLimits.wakeAdmissionMs ||
    policy.frames !== 30 ||
    policy.modelCalls !== 60 ||
    policy.telegramMessages !== 1 ||
    policy.speechPlays !== 1 ||
    policy.speakerFingerprint !== deliverySpeaker ||
    policy.clip !== deliveryClip ||
    !chat ||
    policy.telegramChatFingerprint !== fingerprint(chat) ||
    (daylight !== undefined &&
      (!daylight ||
        !Number.isFinite(daylight.startsAt) ||
        !Number.isFinite(daylight.expiresAt) ||
        daylight.startsAt > now ||
        daylight.expiresAt <= now ||
        daylight.expiresAt > policy.expiresAt ||
        daylight.expiresAt - daylight.startsAt > boundedYardLimits.durationMs)) ||
    (policy.testSetting !== undefined && policy.testSetting !== 'office') ||
    (policy.speakerVolume !== undefined &&
      (policy.testSetting !== 'office' ||
        typeof policy.speakerVolume !== 'number' ||
        !Number.isFinite(policy.speakerVolume) ||
        policy.speakerVolume <= 0 ||
        policy.speakerVolume > 1 ||
        Number(policy.speakerVolume.toFixed(2)) !== policy.speakerVolume)) ||
    (policy.recovery !== undefined &&
      (typeof policy.recovery !== 'object' ||
        policy.recovery === null ||
        !deliveryRecoveryShapes.some(
          (shape) => JSON.stringify(policy.recovery) === JSON.stringify(shape),
        )))
  )
    throw new Error('invalid_or_expired_delivery_policy');
}

export function deliveryAuthorityActive(policy: DeliveryPolicy, now = Date.now()) {
  return (
    now < policy.expiresAt &&
    (policy.daylightTest === undefined ||
      (now >= policy.daylightTest.startsAt && now < policy.daylightTest.expiresAt))
  );
}

export function deliveryWindowOpen(policy: DeliveryPolicy, cfg: PipelineConfig, now = Date.now()) {
  return (
    deliveryAuthorityActive(policy, now) &&
    (policy.daylightTest !== undefined ||
      inWindow(now, cfg.nightWindow.start, cfg.nightWindow.end, cfg.timezone))
  );
}

export function deliveryTestConfig(
  policy: DeliveryPolicy,
  cfg: PipelineConfig,
  now = Date.now(),
): PipelineConfig {
  // Actual capture time, night window, visitor/routine vetoes and wildlife policy stay intact.
  if (!deliveryAuthorityActive(policy, now)) return cfg;
  const daylight = policy.daylightTest !== undefined;
  const office = policy.testSetting === 'office';
  return daylight || office
    ? {
        ...cfg,
        context: {
          ...cfg.context,
          ...(daylight ? { mode: 'away' as const } : {}),
          ...(office ? { testSetting: 'office' as const } : {}),
        },
      }
    : cfg;
}

export function deliveryAlertText(policy: Pick<DeliveryPolicy, 'testSetting'>, id: string) {
  return policy.testSetting === 'office'
    ? `Quiet Porch supervised OFFICE test ${id}: person observed by the test camera, temporarily in the office (configured zone: front yard). One-encounter test; automatic stop is enabled.`
    : `Quiet Porch attended yard test ${id}: person observed at the front yard. One-encounter test; automatic stop is enabled.`;
}

// The approval is consumed before any remote operation. Failed runs cannot replay it.
export function claimDeliveryRun(state: string, approvalReference: string) {
  const lock = join(state, 'ATTENDED-TEST.lock');
  const owned = randomUUID();
  writeFileSync(lock, owned, { flag: 'wx', mode: 0o600 });
  const owns = () => existsSync(lock) && readFileSync(lock, 'utf8') === owned;
  const release = () => {
    if (owns()) unlinkSync(lock);
  };
  try {
    if (existsSync(join(state, 'YARD-MONITOR.lock'))) throw new Error('ongoing_monitor_present');
    const ledger = join(state, 'attended-approvals');
    mkdirSync(ledger, { recursive: true, mode: 0o700 });
    const approvalHash = createHash('sha256').update(approvalReference).digest('hex');
    writeFileSync(
      join(ledger, `${approvalHash}.json`),
      JSON.stringify({ approvalReference, consumedAt: Date.now() }),
      { flag: 'wx', mode: 0o600 },
    );
    return { owns, release };
  } catch (error) {
    release();
    throw error;
  }
}
