// Explicit, owner-approved one-encounter delivery test. Never starts an ongoing service.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runBoundedYard } from '../src/bounded-yard.ts';
import {
  claimDeliveryRun,
  deliveryAlertText,
  deliveryClip,
  deliveryScopePath,
  deliverySpeaker,
  deliveryAuthorityActive,
  deliveryWindowOpen,
  deliveryTestConfig,
  fingerprint,
  validateDeliveryPolicy,
  type DeliveryPolicy,
} from '../src/attended-delivery-policy.ts';
import { createSpeakerOutput } from '../src/speaker-output.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePipelineConfig } from '../src/pipeline.ts';
import { readMotionWakeups } from '../src/attended-source.ts';
import { bedrockConfigFromEnv, converse } from '../src/bedrock.ts';
import { downloadImageAt } from '../src/ring.ts';
import type { TestScope } from '../src/attended-test.ts';

const args = process.argv.slice(2);
if (
  args.length !== 5 ||
  args[0] !== '--deliver-authorized' ||
  args[1] !== '--policy' ||
  args[3] !== '--output'
) {
  console.error(
    'Usage: node scripts/deliver-yard-once.ts --deliver-authorized --policy APPROVED.json --output NEW_DIRECTORY',
  );
  process.exitCode = 2;
} else {
  const policy = JSON.parse(readFileSync(resolve(args[2]), 'utf8')) as DeliveryPolicy;
  const scopePath = deliveryScopePath;
  const state = '/home/apexaipc/.local/state/quiet-porch';
  const configPath = '/home/apexaipc/projects/quiet-porch/config/quiet-porch.json';
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChat = process.env.TELEGRAM_HOME_CHANNEL ?? '';
  validateDeliveryPolicy(policy, telegramChat);
  if (!telegramToken) throw new Error('notification_credentials_unavailable');
  const binding = JSON.parse(readFileSync(scopePath, 'utf8')) as {
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
    binding.stateDir !== state ||
    binding.configPath !== configPath ||
    binding.scope.zone !== 'front_yard' ||
    fingerprint(binding.scope.accountId) !== '48178e372779' ||
    fingerprint(binding.scope.deviceId) !== 'b9499d1805b6' ||
    binding.piHost !== 'rpi-claw' ||
    fingerprint(binding.speakerAddress.toUpperCase()) !== deliverySpeaker ||
    binding.telegramTokenEnv !== 'TELEGRAM_BOT_TOKEN' ||
    binding.telegramChatEnv !== 'TELEGRAM_HOME_CHANNEL'
  )
    throw new Error('invalid_delivery_scope');
  const model = bedrockConfigFromEnv();
  if (model.modelId !== policy.modelId || model.region !== policy.region)
    throw new Error('model_or_route_differs_from_approval');
  const output = resolve(args[4]);
  const realParent = realpathSync(dirname(output));
  const realState = realpathSync(state);
  if (realParent === realState || realParent.startsWith(realState + sep) || existsSync(output))
    throw new Error('delivery_requires_new_isolated_directory');
  const db = new DatabaseSync(resolve(state, 'quiet-porch.db'), { readOnly: true });
  const config = () => parsePipelineConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const tokens = () =>
    JSON.parse(readFileSync(resolve(state, 'tokens.json'), 'utf8')).tokens as {
      account_id: string;
      claimed: boolean;
      integration_status: string;
      expires_at: number;
      access_token: string;
    }[];
  const boundToken = () =>
    tokens().find(
      (t) =>
        t.account_id === binding.scope.accountId &&
        t.claimed &&
        t.integration_status === 'completed' &&
        t.expires_at > Date.now(),
    );
  let claim: ReturnType<typeof claimDeliveryRun> | undefined;
  const authorized = () =>
    deliveryAuthorityActive(policy) &&
    config().dryRun === true &&
    config().zones[binding.scope.deviceId] === binding.scope.zone &&
    !existsSync(resolve(state, 'YARD-MONITOR.lock')) &&
    (claim ? claim.owns() : !existsSync(resolve(state, 'ATTENDED-TEST.lock'))) &&
    db
      .prepare('SELECT account_id FROM household_devices WHERE device_id=?')
      .get(binding.scope.deviceId)?.account_id === binding.scope.accountId &&
    db.prepare("SELECT count(*) AS n FROM incidents WHERE status='active'").get()?.n === 0 &&
    db.prepare('SELECT count(*) AS n FROM reconcile WHERE resolved_at IS NULL').get()?.n === 0 &&
    !!boundToken();
  if (!authorized()) {
    db.close();
    throw new Error('delivery_not_authorized_or_live_monitor_running');
  }
  mkdirSync(output, { mode: 0o700 });
  const journal = resolve(output, 'observations.private.jsonl');
  const audit = (row: Record<string, unknown>) =>
    appendFileSync(journal, JSON.stringify({ utc: new Date().toISOString(), ...row }) + '\n', {
      mode: 0o600,
    });
  const killed = () =>
    existsSync(resolve(state, 'KILL')) || existsSync(resolve(state, 'YARD-MONITOR-DISARM'));
  const abort = new AbortController();
  let safeToRelease = true;
  const onSignal = () => abort.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    claim = claimDeliveryRun(state, policy.approvalReference);
    if (!authorized() || killed()) throw new Error('delivery_admission_refused');
    const initialCooldown = JSON.parse(
      readFileSync(resolve(state, 'yard-monitor-runtime.json'), 'utf8'),
    ).cooldownUntil;
    if (!Number.isFinite(initialCooldown) || Date.now() < initialCooldown)
      throw new Error('delivery_cooldown_active_or_invalid');
    const exec = promisify(execFile);
    const ssh = async (command: string, signal?: AbortSignal) =>
      (
        await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', 'rpi-claw', command], {
          timeout: 2500,
          signal,
        })
      ).stdout.trim();
    const speaker = createSpeakerOutput({
      ssh,
      speakerFingerprint: deliverySpeaker,
      requiredVolume: policy.speakerVolume,
      clip: deliveryClip,
      authorized,
      authorityRemainingMs: () =>
        Math.min(policy.expiresAt, policy.daylightTest?.expiresAt ?? Infinity) - Date.now(),
      killed,
      audit,
    });
    if (!(await speaker.ready(abort.signal)) || !authorized() || killed())
      throw new Error('speaker_preflight_failed');
    audit({
      event: 'attended_delivery_context',
      daylight_test: policy.daylightTest !== undefined,
      simulated_mode: policy.daylightTest ? 'away' : undefined,
      daylight_expires_at: policy.daylightTest?.expiresAt,
      test_setting: policy.testSetting ?? 'configured_zone',
      speech_clip_role:
        policy.testSetting === 'office' ? 'playback_fixture_not_location_claim' : undefined,
      new_frame_recovery: policy.recovery ? 'one_new_frame' : 'disabled',
      recovery_causes: policy.recovery?.causes ?? [],
      speaker_volume_required: policy.speakerVolume ?? 'speaker_default',
    });
    // The cursor is captured after preflight: only subsequent ingested wakes are eligible.
    console.log(
      JSON.stringify({
        event: 'attended_delivery_waiting',
        wait_seconds: 300,
        max_total_seconds: 360,
      }),
    );
    safeToRelease = false;
    const result = await runBoundedYard(
      {
        scope: binding.scope,
        modelId: model.modelId,
        region: model.region,
        config: () => deliveryTestConfig(policy, config()),
        authorized,
        initialCooldown,
        recoveryCauses: policy.recovery?.causes ?? [],
        signal: abort.signal,
        killed,
        night: () => deliveryWindowOpen(policy, config()),
        cursor: Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()?.id),
        readWakes: (cursor) => readMotionWakeups(db, cursor, binding.scope, Date.now()),
        download: async (_account, device, timestamp, options) => {
          if (!authorized()) throw new Error('delivery_authority_lost');
          const token = boundToken();
          if (!token) throw new Error('camera_token_unavailable');
          return downloadImageAt(token.access_token, device, timestamp, options);
        },
        converse: async (content, signal, onResponse) => {
          if (!authorized()) throw new Error('delivery_authority_lost');
          return (
            await converse({ ...model, timeoutMs: 4000 }, content, {
              onResponse,
              fetchImpl: (input, init) => fetch(input, { ...init, signal }),
            })
          ).text;
        },
        audit,
        reserve: (until) => {
          const runtime = resolve(state, 'yard-monitor-runtime.json');
          const current = JSON.parse(readFileSync(runtime, 'utf8'));
          if (!Number.isFinite(current.cooldownUntil)) throw new Error('invalid_shared_cooldown');
          const temporary = resolve(state, `yard-monitor-runtime.${process.pid}.tmp`);
          writeFileSync(
            temporary,
            JSON.stringify({ ...current, cooldownUntil: Math.max(current.cooldownUntil, until) }),
            { mode: 0o600, flag: 'wx' },
          );
          renameSync(temporary, runtime);
        },
      },
      {
        mode: 'attended_delivery',
        ready: () => speaker.ready(abort.signal),
        outputs: {
          ...speaker.outputs(),
          async alert(id, signal, _allowed, guard) {
            guard.assert();
            const response = await fetch(
              `https://api.telegram.org/bot${telegramToken}/sendMessage`,
              {
                method: 'POST',
                signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: telegramChat,
                  text: deliveryAlertText(policy, id),
                }),
              },
            );
            const receipt = (await response.json()) as {
              ok?: boolean;
              result?: { message_id?: number };
            };
            if (!response.ok || receipt.ok !== true) throw new Error('alert_not_acknowledged');
            audit({ event: 'telegram_api_acknowledged', message_id: receipt.result?.message_id });
          },
        },
      },
    );
    safeToRelease = result.drained && result.cleanup_succeeded;
    writeFileSync(resolve(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(JSON.stringify(result));
    if (!result.safety_pass || result.transport_result === 'fail') process.exitCode = 1;
  } finally {
    abort.abort();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (safeToRelease) claim?.release();
    else audit({ event: 'delivery_lock_retained', reason: 'cleanup_or_drain_unconfirmed' });
    db.close();
  }
}
