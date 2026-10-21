// Explicit local one-shot runner. Importing this file is not a supported interface.
// No defaults activate it. Approval policy is supplied only after the owner approves its scope.
import { appendFileSync, existsSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAttendedTest, type TestScope } from '../src/attended-test.ts';
import { readAttendedEvidence } from '../src/attended-source.ts';
import { parsePipelineConfig } from '../src/pipeline.ts';
import { createAttendedObserver } from '../src/attended-observer.ts';
import { downloadImageAt } from '../src/ring.ts';
import { bedrockConfigFromEnv, converse } from '../src/bedrock.ts';

const args = process.argv.slice(2);
if (
  args.length !== 6 ||
  args[0] !== '--execute' ||
  args[1] !== '--policy' ||
  args[3] !== '--state-dir' ||
  args[5] !== '--attended'
)
  throw new Error(
    'No action: --execute --policy APPROVED_PRIVATE_JSON --state-dir STATE --attended required',
  );
const policy = JSON.parse(readFileSync(resolve(args[2]), 'utf8')) as {
  approvalReference: string;
  evidenceMode: 'recorded-followups';
  scope: TestScope;
  expiresAt: number;
  configPath: string;
  piHost: string;
  speakerAddress: string;
  telegramTokenEnv: string;
  telegramChatEnv: string;
};
const now = Date.now();
if (
  !policy.approvalReference ||
  policy.evidenceMode !== 'recorded-followups' ||
  !Number.isFinite(policy.expiresAt) ||
  policy.expiresAt <= now ||
  policy.expiresAt - now > 60000 ||
  policy.piHost !== 'rpi-claw' ||
  !/^(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}$/.test(policy.speakerAddress) ||
  !policy.scope?.accountId ||
  !policy.scope.deviceId ||
  policy.scope.zone !== 'front_yard' ||
  !/^[A-Z_][A-Z0-9_]*$/.test(policy.telegramTokenEnv) ||
  !/^[A-Z_][A-Z0-9_]*$/.test(policy.telegramChatEnv)
)
  throw new Error('Invalid or expired bounded approval policy');
const state = resolve(args[4]);
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
  // This policy grants only ephemeral scope, never primary-household designation or a DB write.
  return (
    Date.now() < policy.expiresAt &&
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
const modelConfig = { ...bedrockConfigFromEnv(), timeoutMs: 2000 };
const lock = resolve(state, 'ATTENDED-TEST.lock');
const journal = resolve(state, `attended-${Date.now()}.jsonl`);
// Consume the approval reference once, even if preflight fails; no automatic retry.
const used = resolve(
  state,
  `attended-approval-${createHash('sha256').update(policy.approvalReference).digest('hex')}.used`,
);
closeSync(openSync(used, 'wx', 0o600));
closeSync(openSync(lock, 'wx', 0o600)); // cross-process exclusion; stale lock requires owner inspection
let speechMayHaveStarted = false;
const test = createAttendedTest({
  scope: policy.scope,
  authorize: authorized,
  ready,
  killed: () => existsSync(resolve(state, 'KILL')) || existsSync(resolve(state, 'ATTENDED-DISARM')),
  audit: (row) => appendFileSync(journal, JSON.stringify(row) + '\n', { mode: 0o600 }),
  outputs: {
    async alert(id, signal) {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text: `Quiet Porch attended test ${id}: person at front yard. To stop, the attending operator must disarm locally.`,
        }),
      });
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error('alert_not_acknowledged');
    },
    async speak(id, signal) {
      if (
        !(await ready()) ||
        signal.aborted ||
        !authorized() ||
        existsSync(resolve(state, 'KILL')) ||
        existsSync(resolve(state, 'ATTENDED-DISARM'))
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
  },
});
const observer = createAttendedObserver({
  scope: policy.scope,
  config,
  allowed: () =>
    test.status().state === 'armed' &&
    authorized() &&
    !existsSync(resolve(state, 'KILL')) &&
    !existsSync(resolve(state, 'ATTENDED-DISARM')),
  download: async (account, device, ts, opts) => {
    const tokens = JSON.parse(readFileSync(resolve(state, 'tokens.json'), 'utf8')).tokens as {
      account_id: string;
      claimed: boolean;
      integration_status: string;
      expires_at: number;
      access_token: string;
    }[];
    const t = tokens.find(
      (t) => t.account_id === account && t.claimed && t.integration_status === 'completed',
    );
    if (!t || t.expires_at <= Date.now()) throw new Error('existing_camera_token_unavailable');
    return downloadImageAt(t.access_token, device, ts, {
      ...opts,
      signal: AbortSignal.any([
        test.signal,
        AbortSignal.timeout(Math.max(1, Math.min(2000, policy.expiresAt - Date.now()))),
      ]),
    });
  },
  converse: async (content) =>
    (
      await converse(modelConfig, content, {
        fetchImpl: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              test.signal,
              AbortSignal.timeout(Math.max(1, Math.min(2000, policy.expiresAt - Date.now()))),
            ]),
          }),
      })
    ).text,
  audit: (row) =>
    appendFileSync(
      journal,
      JSON.stringify({ utc: new Date().toISOString(), session: test.status().id, ...row }) + '\n',
      { mode: 0o600 },
    ),
});
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => {
    void test.disarm(sig);
  });
let cursor = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM decisions').get()?.id);
try {
  // Preflight failure cannot emit audio or alert. Safety stop is issued only after a possible speech dispatch.
  await test.arm();
  console.log(
    `Bounded session active; emergency Ctrl-C or create ${resolve(state, 'ATTENDED-DISARM')}. Private journal: ${journal}`,
  );
  while (test.status().state === 'armed') {
    const batch = readAttendedEvidence(db, cursor, policy.scope);
    cursor = batch.after;
    for (const frame of batch.frames) await test.feed(frame);
    if (test.status().state === 'armed' && test.status().encounterStarted) {
      const observation = await observer.poll();
      if (observation) await test.feed(observation);
    }
    await test.tick();
    await new Promise((r) => setTimeout(r, 100));
  }
} catch {
  process.exitCode = 1;
  await test.disarm('observer_or_runner_failure');
} finally {
  await test.disarm('runner_exit');
  console.log(JSON.stringify({ session: test.status(), journal }));
  if (test.status().cleanupSucceeded !== true) process.exitCode = 1;
  db.close();
  unlinkSync(lock);
}
