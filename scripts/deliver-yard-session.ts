// Explicit, owner-approved bounded office session: up to 3 encounters in at most 60 minutes,
// ending at the first output. One approval, consumed before any remote call. Never starts an
// ongoing service, never restarts itself.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deliveryClip, deliverySpeaker } from '../src/attended-delivery-policy.ts';
import {
  sessionAlertText,
  sessionAuthorityActive,
  sessionTestConfig,
  validateSessionPolicy,
  type SessionPolicy,
} from '../src/attended-session-policy.ts';
import { runAttendedSession } from '../src/attended-session.ts';
import { readMotionWakeups } from '../src/attended-source.ts';
import { bedrockConfigFromEnv, converse } from '../src/bedrock.ts';
import { runBoundedYard } from '../src/bounded-yard.ts';
import { downloadImageAt } from '../src/ring.ts';
import { createSpeakerOutput } from '../src/speaker-output.ts';
import {
  deliveryState,
  loadDeliveryBinding,
  newIsolatedOutput,
  openDeliveryRuntime,
  sendTelegram,
} from './delivery-runtime.ts';

const args = process.argv.slice(2);
if (
  args.length !== 5 ||
  args[0] !== '--session-authorized' ||
  args[1] !== '--policy' ||
  args[3] !== '--output'
) {
  console.error(
    'Usage: node scripts/deliver-yard-session.ts --session-authorized --policy APPROVED.json --output NEW_DIRECTORY',
  );
  process.exitCode = 2;
} else {
  const policy = JSON.parse(readFileSync(resolve(args[2]), 'utf8')) as SessionPolicy;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChat = process.env.TELEGRAM_HOME_CHANNEL ?? '';
  validateSessionPolicy(policy, telegramChat);
  if (!telegramToken) throw new Error('notification_credentials_unavailable');
  const binding = loadDeliveryBinding();
  const model = bedrockConfigFromEnv();
  if (model.modelId !== policy.modelId || model.region !== policy.region)
    throw new Error('model_or_route_differs_from_approval');
  const boundToken = () =>
    (
      JSON.parse(readFileSync(resolve(deliveryState, 'tokens.json'), 'utf8')).tokens as {
        account_id: string;
        claimed: boolean;
        integration_status: string;
        expires_at: number;
        access_token: string;
      }[]
    ).find(
      (t) =>
        t.account_id === binding.scope.accountId &&
        t.claimed &&
        t.integration_status === 'completed' &&
        t.expires_at > Date.now(),
    );
  const rt = openDeliveryRuntime(
    binding,
    () => sessionAuthorityActive(policy),
    () => !!boundToken(),
  );
  // Before a scheduled start only the window is closed; everything else must already hold.
  if (!rt.standing() || Date.now() >= policy.expiresAt) {
    rt.db.close();
    throw new Error('session_not_authorized_or_live_monitor_running');
  }
  const { audit, writeSummary } = newIsolatedOutput(args[4]);
  const abort = new AbortController();
  let safeToRelease = true;
  const onSignal = () => abort.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    rt.claim(policy.approvalReference);
    if (!rt.standing() || rt.killed()) throw new Error('session_admission_refused');
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
    if (!(await speaker.ready(abort.signal)) || !rt.standing() || rt.killed())
      throw new Error('speaker_preflight_failed');
    audit({
      event: 'attended_session_context',
      test_setting: 'office',
      simulated_mode: 'away',
      speech_clip_role: 'playback_fixture_not_location_claim',
      new_frame_recovery: policy.recovery ? 'one_new_frame' : 'disabled',
      recovery_causes: policy.recovery?.causes ?? [],
      speaker_volume_required: policy.speakerVolume ?? 'speaker_default',
    });
    console.log(
      JSON.stringify({
        event: 'attended_session_waiting',
        starts_at: new Date(policy.startsAt).toISOString(),
        expires_at: new Date(policy.expiresAt).toISOString(),
      }),
    );
    safeToRelease = false;
    const summary = await runAttendedSession({
      startsAt: policy.startsAt,
      expiresAt: policy.expiresAt,
      maxEncounters: policy.maxEncounters,
      totals: policy.sessionTotals,
      // Only wakes ingested after this point are ever eligible.
      cursor: rt.eventCursor(),
      readWakes: (cursor) => readMotionWakeups(rt.db, cursor, binding.scope, Date.now()),
      cooldownUntil: rt.cooldownUntil,
      authorized: rt.authorized,
      killed: rt.killed,
      signal: abort.signal,
      audit,
      runSlot: (slot) =>
        runBoundedYard(
          {
            scope: binding.scope,
            modelId: model.modelId,
            region: model.region,
            config: () => sessionTestConfig(policy, rt.config()),
            authorized: rt.authorized,
            initialCooldown: rt.cooldownUntil(),
            recoveryCauses: policy.recovery?.causes ?? [],
            signal: abort.signal,
            killed: rt.killed,
            night: () => sessionAuthorityActive(policy),
            cursor: 0, // ignored: the session owns the cursor through slot.readWakes
            readWakes: slot.readWakes,
            download: async (_account, device, timestamp, options) => {
              if (!rt.authorized()) throw new Error('delivery_authority_lost');
              slot.spendFrame();
              const token = boundToken();
              if (!token) throw new Error('camera_token_unavailable');
              return downloadImageAt(token.access_token, device, timestamp, options);
            },
            converse: async (content, signal, onResponse) => {
              if (!rt.authorized()) throw new Error('delivery_authority_lost');
              slot.spendModelCall();
              return (
                await converse({ ...model, timeoutMs: 4000 }, content, {
                  onResponse,
                  fetchImpl: (input, init) => fetch(input, { ...init, signal }),
                })
              ).text;
            },
            audit: (row) => audit({ slot: slot.slot, encounter: slot.encounter, ...row }),
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
                  sessionAlertText(id, slot.encounter, policy.maxEncounters),
                  signal,
                  audit,
                );
              },
            },
          },
        ),
    });
    safeToRelease = summary.drained && summary.cleanup_succeeded;
    writeSummary(summary);
    console.log(JSON.stringify(summary));
    if (!summary.safety_pass || summary.transport_result === 'fail') process.exitCode = 1;
  } finally {
    abort.abort();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (safeToRelease) rt.owned()?.release();
    else audit({ event: 'delivery_lock_retained', reason: 'cleanup_or_drain_unconfirmed' });
    rt.db.close();
  }
}
