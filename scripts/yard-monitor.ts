// Explicit local one-shot runner. Importing this file is not a supported interface.
// No defaults activate it. Approval policy is supplied only after the owner approves its scope.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type TestScope, type TestOutputs } from '../src/attended-test.ts';
import { readMotionWakeups } from '../src/attended-source.ts';
import { parsePipelineConfig } from '../src/pipeline.ts';
import { createAttendedObserver } from '../src/attended-observer.ts';
import { downloadImageAt } from '../src/ring.ts';
import { bedrockConfigFromEnv, converse } from '../src/bedrock.ts';
import { createYardMonitor } from '../src/yard-monitor.ts';
import { inWindow } from '../src/decide.ts';

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--arm-ongoing' || args[1] !== '--scope')
  throw new Error('Explicit ongoing owner authorization required');
const policy = JSON.parse(readFileSync(resolve(args[2]), 'utf8')) as {
  operation: string;
  approvalReference: string;
  scope: TestScope;
  configPath: string;
  piHost: string;
  speakerAddress: string;
  telegramTokenEnv: string;
  telegramChatEnv: string;
  stateDir: string;
};
if (
  policy.operation !== 'ongoing-yard-monitor' ||
  policy.approvalReference !== 'Sentinel_ad79239d66dc8191af81caf9f24cc455' ||
  policy.scope.zone !== 'front_yard' ||
  createHash('sha256').update(policy.scope.accountId).digest('hex').slice(0, 12) !==
    '48178e372779' ||
  createHash('sha256').update(policy.scope.deviceId).digest('hex').slice(0, 12) !==
    'b9499d1805b6' ||
  policy.telegramTokenEnv !== 'TELEGRAM_BOT_TOKEN' ||
  policy.telegramChatEnv !== 'TELEGRAM_HOME_CHANNEL' ||
  policy.stateDir !== '/home/apexaipc/.local/state/quiet-porch' ||
  policy.configPath !== '/home/apexaipc/projects/quiet-porch/config/quiet-porch.json' ||
  policy.piHost !== 'rpi-claw' ||
  !/^(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}$/.test(policy.speakerAddress)
)
  throw new Error('Invalid ongoing scope');
const state = resolve(policy.stateDir);
const db = new DatabaseSync(resolve(state, 'quiet-porch.db'), { readOnly: true });
const config = () => parsePipelineConfig(JSON.parse(readFileSync(policy.configPath, 'utf8')));
const authorized = () => {
  const cfg = config();
  const tokens = JSON.parse(readFileSync(resolve(state, 'tokens.json'), 'utf8')).tokens as {
    account_id: string;
    claimed: boolean;
    integration_status: string;
  }[];
  const bound = db
    .prepare('SELECT account_id FROM household_devices WHERE device_id=?')
    .get(policy.scope.deviceId);
  // This policy grants process-lifetime scope, never primary-household designation or a DB write.
  return (
    policy.operation === 'ongoing-yard-monitor' &&
    !existsSync(resolve(state, 'ATTENDED-TEST.lock')) &&
    cfg.dryRun === true &&
    cfg.zones[policy.scope.deviceId] === policy.scope.zone &&
    bound?.account_id === policy.scope.accountId &&
    tokens.some(
      (t) =>
        t.account_id === policy.scope.accountId &&
        t.claimed &&
        t.integration_status === 'completed',
    ) &&
    db.prepare("SELECT count(*) AS n FROM incidents WHERE status='active'").get()?.n === 0 &&
    db.prepare('SELECT count(*) AS n FROM reconcile WHERE resolved_at IS NULL').get()?.n === 0
  );
};
if (!authorized()) throw new Error('Owner/device binding or safety state not verified');
const token = process.env[policy.telegramTokenEnv],
  chat = process.env[policy.telegramChatEnv];
if (!token || !chat) throw new Error('Existing notification credentials not supplied');
const exec = promisify(execFile);
const ssh = async (command: string, signal?: AbortSignal) =>
  (
    await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', policy.piHost, command], {
      timeout: 3000,
      signal,
    })
  ).stdout.trim();
const clip = 'speech-6fa6f1f5966142279ab93f3b1fa91dc1dd98d210c47af2ae879f964df24cb6aa';
async function ready() {
  const sink = await ssh('wpctl inspect @DEFAULT_AUDIO_SINK@');
  const volume = await ssh('wpctl get-volume @DEFAULT_AUDIO_SINK@');
  const match = /^Volume: ([0-9.]+)$/.exec(volume);
  const helper = await ssh('cat "$(command -v qp-speak)"');
  return (
    !/auto_null|Dummy Output|node.virtual = "true"/.test(sink) &&
    sink
      .match(/node\.name = "bluez_output\.([^"]+)"/)?.[1]
      .replaceAll('_', ':')
      .toUpperCase() === policy.speakerAddress.toUpperCase() &&
    !!match &&
    Number(match[1]) > 0 &&
    Number(match[1]) <= 0.6 &&
    (await ssh('qp-status')) === 'idle' &&
    helper.includes('-p RuntimeMaxSec=4') &&
    (await ssh(`test -f "$HOME/quiet-porch/clips/${clip}.wav" && echo present`)) === 'present'
  );
}

const modelConfig = { ...bedrockConfigFromEnv(), timeoutMs: 4000 };
const lock = resolve(state, 'YARD-MONITOR.lock');
const journal = resolve(state, `yard-monitor-${Date.now()}.jsonl`);
const statusPath = resolve(state, 'yard-monitor-status.json');
const runtimePath = resolve(state, 'yard-monitor-runtime.json');
const prior = existsSync(runtimePath)
  ? (JSON.parse(readFileSync(runtimePath, 'utf8')) as { cooldownUntil: number })
  : { cooldownUntil: 0 };
if (!Number.isFinite(prior.cooldownUntil)) throw new Error('Invalid persistent cooldown');
closeSync(openSync(lock, 'wx', 0o600));
const journalRow = (row: Record<string, unknown>) =>
  appendFileSync(journal, JSON.stringify({ utc: new Date().toISOString(), ...row }) + '\n', {
    mode: 0o600,
  });
const killed = () =>
  existsSync(resolve(state, 'KILL')) || existsSync(resolve(state, 'YARD-MONITOR-DISARM'));
function outputFactory(): TestOutputs {
  let speechMayHaveStarted = false;
  return {
    async alert(id, signal, allowed) {
      if (!allowed()) throw new Error('action_evidence_expired');
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text: `Quiet Porch yard monitor ${id}: person at front yard. To stop, disarm the yard monitor from its local control.`,
        }),
      });
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error('alert_not_acknowledged');
    },
    async speak(id, signal, allowed) {
      if (
        !(await ready()) ||
        !allowed() ||
        signal.aborted ||
        !authorized() ||
        existsSync(resolve(state, 'KILL')) ||
        existsSync(resolve(state, 'YARD-MONITOR-DISARM'))
      )
        throw new Error('audio_not_ready_or_authorized');
      speechMayHaveStarted = true; // Mark before dispatch, including an ambiguous SSH result.
      const response = await ssh(`qp-speak ${id} ${Date.now()} ${clip}`, signal);
      if (response !== `started qp-audio-${id}`) throw new Error('playback_not_acknowledged');
    },
    async stop() {
      if (speechMayHaveStarted) {
        const r = await ssh(`qp-stop ${Date.now() + 1}`);
        if (r !== 'stopped' || (await ssh('qp-status')) !== 'idle')
          throw new Error('cleanup_not_acknowledged');
      }
    },
  };
}
const monitor = createYardMonitor({
  scope: policy.scope,
  authorized,
  killed,
  night: () => {
    const c = config();
    return inWindow(Date.now(), c.nightWindow.start, c.nightWindow.end, c.timezone);
  },
  ready,
  outputs: outputFactory,
  audit: journalRow,
  initialCooldown: prior.cooldownUntil,
  reserve: (until) =>
    writeFileSync(runtimePath, JSON.stringify({ cooldownUntil: until }), { mode: 0o600 }),
});
let observer: ReturnType<typeof createAttendedObserver> | undefined;
let observing: string | undefined;
function makeObserver() {
  return createAttendedObserver({
    parallelCritique: true,
    scope: policy.scope,
    config,
    allowed: () =>
      monitor.status().running &&
      !!monitor.current() &&
      !monitor.current()!.signal.aborted &&
      authorized() &&
      !killed(),
    download: async (account, device, ts, opts) => {
      const rows = JSON.parse(readFileSync(resolve(state, 'tokens.json'), 'utf8')).tokens as {
        account_id: string;
        claimed: boolean;
        integration_status: string;
        expires_at: number;
        access_token: string;
      }[];
      const token = rows.find(
        (t) => t.account_id === account && t.claimed && t.integration_status === 'completed',
      );
      if (!token || token.expires_at <= Date.now()) throw new Error('camera_token_unavailable');
      return downloadImageAt(token.access_token, device, ts, {
        ...opts,
        signal: AbortSignal.any([monitor.current()!.signal, AbortSignal.timeout(2000)]),
      });
    },
    converse: async (content) =>
      (
        await converse(modelConfig, content, {
          fetchImpl: (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([monitor.current()!.signal, AbortSignal.timeout(4000)]),
            }),
        })
      ).text,
    audit: journalRow,
  });
}
const watchdog = setInterval(() => {
  void monitor.tick().catch(() => monitor.stop('watchdog_fault'));
}, 250);
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => {
    void monitor.stop(sig);
  });
let cursor = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()?.id);
try {
  if (!(await ready()) || killed() || !authorized()) throw new Error('monitor_preflight_failed');
  journalRow({
    event: 'monitor_started',
    scope: policy.scope,
    night_only: true,
    no_sprinklers: true,
    no_lights: true,
  });
  while (monitor.status().running) {
    await monitor.tick();
    const batch = readMotionWakeups(db, cursor, policy.scope, Date.now());
    cursor = batch.after;
    for (const wake of batch.wakes) await monitor.wake(wake);
    const current = monitor.current();
    if (current && current.status().state === 'armed') {
      if (observing !== current.status().id) {
        observer = makeObserver();
        observing = current.status().id;
      }
      const frame = await observer!.poll();
      if (frame) await monitor.feed(frame);
    }
    writeFileSync(
      statusPath,
      JSON.stringify({
        checked_utc: new Date().toISOString(),
        pid: process.pid,
        ...monitor.status(),
        scope_label: 'verified owner / Cam1 / front_yard',
        no_sprinklers: true,
        no_lights: true,
        journal,
      }),
      { mode: 0o600 },
    );
    await new Promise((r) => setTimeout(r, 250));
  }
} catch {
  await monitor.stop('source_or_runtime_fault');
  process.exitCode = 1;
} finally {
  clearInterval(watchdog);
  await monitor.stop('process_exit');
  writeFileSync(
    statusPath,
    JSON.stringify({
      checked_utc: new Date().toISOString(),
      pid: process.pid,
      ...monitor.status(),
      no_sprinklers: true,
      no_lights: true,
      journal,
    }),
    { mode: 0o600 },
  );
  db.close();
  unlinkSync(lock);
}
