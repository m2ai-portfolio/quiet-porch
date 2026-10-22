// Shared wiring for the owner-approved session and replay CLIs. The same bindings and
// authority checks as deliver-yard-once.ts, which is deliberately left unchanged.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  claimDeliveryRun,
  deliveryScopePath,
  deliverySpeaker,
  fingerprint,
} from '../src/attended-delivery-policy.ts';
import { parsePipelineConfig } from '../src/pipeline.ts';
import type { TestScope } from '../src/attended-test.ts';

export const deliveryState = '/home/apexaipc/.local/state/quiet-porch';
export const deliveryConfigPath = '/home/apexaipc/projects/quiet-porch/config/quiet-porch.json';

export function loadDeliveryBinding() {
  const binding = JSON.parse(readFileSync(deliveryScopePath, 'utf8')) as {
    scope: TestScope;
    stateDir: string;
    configPath: string;
    operation: string;
    piHost: string;
    speakerAddress: string;
    telegramTokenEnv: string;
    telegramChatEnv: string;
  };
  if (
    binding.operation !== 'ongoing-yard-monitor' ||
    binding.stateDir !== deliveryState ||
    binding.configPath !== deliveryConfigPath ||
    binding.scope.zone !== 'front_yard' ||
    fingerprint(binding.scope.accountId) !== '48178e372779' ||
    fingerprint(binding.scope.deviceId) !== 'b9499d1805b6' ||
    binding.piHost !== 'rpi-claw' ||
    fingerprint(binding.speakerAddress.toUpperCase()) !== deliverySpeaker ||
    binding.telegramTokenEnv !== 'TELEGRAM_BOT_TOKEN' ||
    binding.telegramChatEnv !== 'TELEGRAM_HOME_CHANNEL'
  )
    throw new Error('invalid_delivery_scope');
  return binding;
}

export function newIsolatedOutput(path: string) {
  const output = resolve(path);
  const realParent = realpathSync(dirname(output));
  const realState = realpathSync(deliveryState);
  if (realParent === realState || realParent.startsWith(realState + sep) || existsSync(output))
    throw new Error('delivery_requires_new_isolated_directory');
  mkdirSync(output, { mode: 0o700 });
  const journal = resolve(output, 'observations.private.jsonl');
  const audit = (row: Record<string, unknown>) =>
    appendFileSync(journal, JSON.stringify({ utc: new Date().toISOString(), ...row }) + '\n', {
      mode: 0o600,
    });
  const writeSummary = (summary: unknown) =>
    writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {
      mode: 0o600,
    });
  return { output, audit, writeSummary };
}

// windowActive is the policy's own time authority. The rest matches the one-encounter CLI:
// dry-run household config, bound camera zone, no live monitor, this run owns the test lock,
// household device binding, no active incident or unresolved reconcile.
export function openDeliveryRuntime(
  binding: ReturnType<typeof loadDeliveryBinding>,
  windowActive: () => boolean,
  extra: () => boolean = () => true,
) {
  const state = deliveryState;
  const db = new DatabaseSync(resolve(state, 'quiet-porch.db'), { readOnly: true });
  const config = () => parsePipelineConfig(JSON.parse(readFileSync(deliveryConfigPath, 'utf8')));
  let claim: ReturnType<typeof claimDeliveryRun> | undefined;
  // Everything except the policy's time window: checked before a scheduled start.
  const standing = () =>
    config().dryRun === true &&
    config().zones[binding.scope.deviceId] === binding.scope.zone &&
    !existsSync(resolve(state, 'YARD-MONITOR.lock')) &&
    (claim ? claim.owns() : !existsSync(resolve(state, 'ATTENDED-TEST.lock'))) &&
    db
      .prepare('SELECT account_id FROM household_devices WHERE device_id=?')
      .get(binding.scope.deviceId)?.account_id === binding.scope.accountId &&
    db.prepare("SELECT count(*) AS n FROM incidents WHERE status='active'").get()?.n === 0 &&
    db.prepare('SELECT count(*) AS n FROM reconcile WHERE resolved_at IS NULL').get()?.n === 0 &&
    extra();
  const authorized = () => windowActive() && standing();
  const killed = () =>
    existsSync(resolve(state, 'KILL')) || existsSync(resolve(state, 'YARD-MONITOR-DISARM'));
  const runtimePath = resolve(state, 'yard-monitor-runtime.json');
  const cooldownUntil = () => {
    const value = JSON.parse(readFileSync(runtimePath, 'utf8')).cooldownUntil;
    if (!Number.isFinite(value)) throw new Error('invalid_shared_cooldown');
    return value as number;
  };
  const reserve = (until: number) => {
    const current = JSON.parse(readFileSync(runtimePath, 'utf8'));
    if (!Number.isFinite(current.cooldownUntil)) throw new Error('invalid_shared_cooldown');
    const temporary = resolve(state, `yard-monitor-runtime.${process.pid}.tmp`);
    writeFileSync(
      temporary,
      JSON.stringify({ ...current, cooldownUntil: Math.max(current.cooldownUntil, until) }),
      { mode: 0o600, flag: 'wx' },
    );
    renameSync(temporary, runtimePath);
  };
  const exec = promisify(execFile);
  const ssh = async (command: string, signal?: AbortSignal) =>
    (
      await exec(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', binding.piHost, command],
        {
          timeout: 2500,
          signal,
        },
      )
    ).stdout.trim();
  return {
    db,
    state,
    config,
    standing,
    authorized,
    killed,
    cooldownUntil,
    reserve,
    ssh,
    claim: (approvalReference: string) => (claim = claimDeliveryRun(state, approvalReference)),
    owned: () => claim,
    eventCursor: () => Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()?.id),
  };
}

export async function sendTelegram(
  token: string,
  chat: string,
  text: string,
  signal: AbortSignal,
  audit: (row: Record<string, unknown>) => void,
) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  const receipt = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
  if (!response.ok || receipt.ok !== true) throw new Error('alert_not_acknowledged');
  audit({ event: 'telegram_api_acknowledged', message_id: receipt.result?.message_id });
}
