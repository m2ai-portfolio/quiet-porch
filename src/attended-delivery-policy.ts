import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedYardLimits } from './bounded-yard.ts';

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
}
export function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
export function validateDeliveryPolicy(policy: DeliveryPolicy, chat: string, now = Date.now()) {
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
    policy.telegramChatFingerprint !== fingerprint(chat)
  )
    throw new Error('invalid_or_expired_delivery_policy');
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
