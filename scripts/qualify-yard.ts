// Explicit one-encounter, output-disabled qualification. No output adapters or subprocesses.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runYardQualification, qualificationLimits } from '../src/yard-qualification.ts';
import { parsePipelineConfig } from '../src/pipeline.ts';
import { readMotionWakeups } from '../src/attended-source.ts';
import { inWindow } from '../src/decide.ts';
import { bedrockConfigFromEnv, converse } from '../src/bedrock.ts';
import { downloadImageAt } from '../src/ring.ts';
import type { TestScope } from '../src/attended-test.ts';

const args = process.argv.slice(2);
if (
  args.length !== 5 ||
  args[0] !== '--observe-authorized' ||
  args[1] !== '--policy' ||
  args[3] !== '--output'
) {
  console.error(
    'Usage: node scripts/qualify-yard.ts --observe-authorized --policy APPROVED.json --output NEW_DIRECTORY',
  );
  process.exitCode = 2;
} else {
  const policy = JSON.parse(readFileSync(resolve(args[2]), 'utf8')) as {
    operation: string;
    approvalReference: string;
    expiresAt: number;
    scopePath: string;
    modelId: string;
    region: string;
    durationMs: number;
    wakeAdmissionMs: number;
  };
  const scopePath =
    '/home/apexaipc/Documents/Codex/2026-10-12/task/quiet-porch-private/ongoing-yard-monitor/scope.private.json';
  const state = '/home/apexaipc/.local/state/quiet-porch';
  const configPath = '/home/apexaipc/projects/quiet-porch/config/quiet-porch.json';
  // No model selection or routing experiment is implicit in this runner.
  if (
    policy.operation !== 'output-disabled-yard-qualification' ||
    !/^owner-approved-[A-Za-z0-9-]{1,80}$/.test(policy.approvalReference) ||
    !Number.isFinite(policy.expiresAt) ||
    policy.expiresAt <= Date.now() ||
    policy.expiresAt > Date.now() + 15 * 60000 ||
    policy.scopePath !== scopePath ||
    policy.modelId !== 'global.anthropic.claude-sonnet-4-6' ||
    policy.region !== 'us-east-1' ||
    policy.durationMs !== qualificationLimits.durationMs ||
    policy.wakeAdmissionMs !== qualificationLimits.wakeAdmissionMs
  )
    throw new Error('invalid_or_expired_qualification_policy');
  const binding = JSON.parse(readFileSync(scopePath, 'utf8')) as {
    scope: TestScope;
    stateDir: string;
    configPath: string;
    operation: string;
  };
  if (
    binding.operation !== 'ongoing-yard-monitor' ||
    binding.stateDir !== state ||
    binding.configPath !== configPath ||
    binding.scope.zone !== 'front_yard'
  )
    throw new Error('invalid_qualification_scope');
  const model = bedrockConfigFromEnv();
  if (model.modelId !== policy.modelId || model.region !== policy.region)
    throw new Error('model_or_route_differs_from_approval');
  const output = resolve(args[4]);
  const realParent = realpathSync(dirname(output));
  const realState = realpathSync(state);
  if (realParent === realState || realParent.startsWith(realState + sep) || existsSync(output))
    throw new Error('qualification_requires_new_isolated_directory');
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
  const authorized = () =>
    Date.now() < policy.expiresAt &&
    config().dryRun === true &&
    config().zones[binding.scope.deviceId] === binding.scope.zone &&
    !existsSync(resolve(state, 'YARD-MONITOR.lock')) &&
    !existsSync(resolve(state, 'ATTENDED-TEST.lock')) &&
    db
      .prepare('SELECT account_id FROM household_devices WHERE device_id=?')
      .get(binding.scope.deviceId)?.account_id === binding.scope.accountId &&
    db.prepare("SELECT count(*) AS n FROM incidents WHERE status='active'").get()?.n === 0 &&
    db.prepare('SELECT count(*) AS n FROM reconcile WHERE resolved_at IS NULL').get()?.n === 0 &&
    !!boundToken();
  const initialCooldown = JSON.parse(
    readFileSync(resolve(state, 'yard-monitor-runtime.json'), 'utf8'),
  ).cooldownUntil;
  if (!Number.isFinite(initialCooldown) || !authorized()) {
    db.close();
    throw new Error('qualification_not_authorized_or_live_monitor_running');
  }
  mkdirSync(output, { mode: 0o700 });
  const journal = resolve(output, 'observations.private.jsonl');
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    const result = await runYardQualification({
      scope: binding.scope,
      modelId: model.modelId,
      region: model.region,
      config,
      authorized,
      initialCooldown,
      signal: abort.signal,
      killed: () =>
        existsSync(resolve(state, 'KILL')) || existsSync(resolve(state, 'YARD-MONITOR-DISARM')),
      night: () => {
        const cfg = config();
        return inWindow(Date.now(), cfg.nightWindow.start, cfg.nightWindow.end, cfg.timezone);
      },
      cursor: Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()?.id),
      readWakes: (cursor) => readMotionWakeups(db, cursor, binding.scope, Date.now()),
      download: async (_account, device, timestamp, options) => {
        if (!authorized()) throw new Error('qualification_authority_lost');
        const token = boundToken();
        if (!token) throw new Error('camera_token_unavailable');
        return downloadImageAt(token.access_token, device, timestamp, options);
      },
      converse: async (content, signal, onResponse) => {
        if (!authorized()) throw new Error('qualification_authority_lost');
        return (
          await converse({ ...model, timeoutMs: 4000 }, content, {
            onResponse,
            fetchImpl: (input, init) => fetch(input, { ...init, signal }),
          })
        ).text;
      },
      audit: (row) =>
        appendFileSync(journal, JSON.stringify({ utc: new Date().toISOString(), ...row }) + '\n', {
          mode: 0o600,
        }),
      reserve: (until) =>
        writeFileSync(
          resolve(output, 'qualification-cooldown.json'),
          JSON.stringify({ cooldownUntil: until }),
          { mode: 0o600 },
        ),
    });
    writeFileSync(resolve(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(JSON.stringify(result));
    if (!result.safety_pass || result.observation_result === 'fail') process.exitCode = 1;
  } finally {
    abort.abort();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    db.close();
  }
}
