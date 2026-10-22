// Explicit, owner-approved labelled delivery replay: one recorded Ring person still through
// the real judgement, Telegram (prefixed "REPLAY ... (not live)") and the Pi speaker. No Ring
// call is possible: this CLI imports no camera client and never reads camera tokens.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deliveryClip, deliverySpeaker } from '../src/attended-delivery-policy.ts';
import {
  replayAlertText,
  replayAuthorityActive,
  replayFixtureRoot,
  replayTestConfig,
  validateReplayPolicy,
  type ReplayPolicy,
} from '../src/attended-session-policy.ts';
import { bedrockConfigFromEnv, converse } from '../src/bedrock.ts';
import { runBoundedYard } from '../src/bounded-yard.ts';
import { checkReplayFixture, createReplaySource } from '../src/delivery-replay.ts';
import { createSpeakerOutput } from '../src/speaker-output.ts';
import {
  loadDeliveryBinding,
  newIsolatedOutput,
  openDeliveryRuntime,
  sendTelegram,
} from './delivery-runtime.ts';

const args = process.argv.slice(2);
if (
  args.length !== 5 ||
  args[0] !== '--replay-authorized' ||
  args[1] !== '--policy' ||
  args[3] !== '--output'
) {
  console.error(
    'Usage: node scripts/deliver-replay-once.ts --replay-authorized --policy APPROVED.json --output NEW_DIRECTORY',
  );
  process.exitCode = 2;
} else {
  const policy = JSON.parse(readFileSync(resolve(args[2]), 'utf8')) as ReplayPolicy;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChat = process.env.TELEGRAM_HOME_CHANNEL ?? '';
  validateReplayPolicy(policy, telegramChat);
  if (!telegramToken) throw new Error('notification_credentials_unavailable');
  const image = readFileSync(resolve(replayFixtureRoot, policy.fixture, 'frame.jpg'));
  checkReplayFixture(image, policy.fixtureSha256);
  const binding = loadDeliveryBinding();
  const model = bedrockConfigFromEnv();
  if (model.modelId !== policy.modelId || model.region !== policy.region)
    throw new Error('model_or_route_differs_from_approval');
  const rt = openDeliveryRuntime(binding, () => replayAuthorityActive(policy));
  if (!rt.authorized()) {
    rt.db.close();
    throw new Error('replay_not_authorized_or_live_monitor_running');
  }
  const { audit, writeSummary } = newIsolatedOutput(args[4]);
  const abort = new AbortController();
  let safeToRelease = true;
  const onSignal = () => abort.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    rt.claim(policy.approvalReference);
    if (!rt.authorized() || rt.killed()) throw new Error('replay_admission_refused');
    const initialCooldown = rt.cooldownUntil();
    if (Date.now() < initialCooldown) throw new Error('delivery_cooldown_active_or_invalid');
    const speaker = createSpeakerOutput({
      ssh: rt.ssh,
      speakerFingerprint: deliverySpeaker,
      requiredVolume: policy.speakerVolume,
      clip: deliveryClip,
      authorized: rt.authorized,
      authorityRemainingMs: () => policy.expiresAt - Date.now(),
      killed: rt.killed,
      audit,
    });
    if (!(await speaker.ready(abort.signal)) || !rt.authorized() || rt.killed())
      throw new Error('speaker_preflight_failed');
    audit({
      event: 'labelled_replay_context',
      source: 'replay',
      live: false,
      fixture: policy.fixture,
      fixture_sha256: policy.fixtureSha256,
      simulated_mode: 'away',
      camera_calls: 'none',
      speaker_volume_required: policy.speakerVolume ?? 'speaker_default',
    });
    const source = createReplaySource({
      scope: binding.scope,
      fixture: policy.fixture,
      image,
      audit,
    });
    safeToRelease = false;
    const result = await runBoundedYard(
      {
        scope: binding.scope,
        modelId: model.modelId,
        region: model.region,
        config: () => replayTestConfig(policy, rt.config()),
        authorized: rt.authorized,
        initialCooldown,
        signal: abort.signal,
        killed: rt.killed,
        night: () => replayAuthorityActive(policy),
        cursor: 0,
        readWakes: source.readWakes,
        download: async (account, device, timestamp, options) => {
          if (!rt.authorized()) throw new Error('replay_authority_lost');
          return source.download(account, device, timestamp, options);
        },
        converse: async (content, signal, onResponse) => {
          if (!rt.authorized()) throw new Error('replay_authority_lost');
          return (
            await converse({ ...model, timeoutMs: 4000 }, content, {
              onResponse,
              fetchImpl: (input, init) => fetch(input, { ...init, signal }),
            })
          ).text;
        },
        audit: (row) => audit({ source: 'replay', ...row }),
        reserve: rt.reserve,
      },
      {
        mode: 'attended_delivery',
        ready: () => speaker.ready(abort.signal),
        outputs: {
          ...speaker.outputs(),
          async alert(id, signal, _allowed, guard) {
            guard.assert();
            await sendTelegram(
              telegramToken,
              telegramChat,
              replayAlertText(policy.fixture, id),
              signal,
              audit,
            );
          },
        },
      },
    );
    const summary = {
      ...result,
      source: 'replay',
      live: false,
      fixture: policy.fixture,
      frames_served: source.served(),
    };
    safeToRelease = result.drained && result.cleanup_succeeded;
    writeSummary(summary);
    console.log(JSON.stringify(summary));
    if (!result.safety_pass || result.transport_result === 'fail') process.exitCode = 1;
  } finally {
    abort.abort();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (safeToRelease) rt.owned()?.release();
    else audit({ event: 'delivery_lock_retained', reason: 'cleanup_or_drain_unconfirmed' });
    rt.db.close();
  }
}
