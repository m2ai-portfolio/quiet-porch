// Fixture evaluation (plan v7 build step 2, "Evaluation"). Runs every labeled frame through the
// same judgeFrame used by the live pipeline, with real Bedrock, and reports expected vs actual.
// Fixtures live outside the repo (they contain household frames):
//   <dir>/<name>/frame.jpg + label.json {expect, night, mode, zone, source, note}
// Usage: node scripts/eval-fixtures.ts [fixture dir]   (Bedrock env vars must be set)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bedrockConfigFromEnv, converse } from '../src/bedrock.ts';
import { evidenceIdFor, judgeFrame, parsePipelineConfig } from '../src/pipeline.ts';

interface Label {
  expect: 'log' | 'intruder' | 'wildlife';
  night: boolean;
  mode: 'home' | 'away' | 'night';
  zone: string;
  source: string;
  note: string;
}

const dir = process.argv[2] ?? join(homedir(), '.local/state/quiet-porch/fixtures/set1');
const cfgPath = join(import.meta.dirname, '../config/quiet-porch.json');
const cfg = parsePipelineConfig(
  JSON.parse(
    readFileSync(
      existsSync(cfgPath)
        ? cfgPath
        : join(import.meta.dirname, '../config/quiet-porch.example.json'),
      'utf8',
    ),
  ),
);
const bedrock = bedrockConfigFromEnv();
const call = async (c: Parameters<typeof converse>[1]) => (await converse(bedrock, c)).text;

const results = [];
for (const name of readdirSync(dir).sort()) {
  let label: Label;
  let jpeg: Buffer;
  try {
    label = JSON.parse(readFileSync(join(dir, name, 'label.json'), 'utf8')) as Label;
    jpeg = readFileSync(join(dir, name, 'frame.jpg'));
  } catch {
    continue; // not a fixture folder
  }
  const captureTs = Date.now();
  const sha = createHash('sha256').update(jpeg).digest('hex');
  const evidenceId = evidenceIdFor(label.zone, `fixture:${name}`, captureTs, sha);
  const j = await judgeFrame(
    jpeg,
    captureTs,
    evidenceId,
    label.zone,
    { ...cfg, context: { ...cfg.context, mode: label.mode } },
    call,
    label.night,
  );
  const pass = j.decision.kind === label.expect;
  const p = j.perception as { subjects?: { class: string; confidence: number }[] };
  const c = j.critique as { verdict?: string } | undefined;
  results.push({
    name,
    expect: label.expect,
    got: j.decision.kind,
    reason: j.decision.reason,
    pass,
    label,
    perception: j.perception,
    critique: j.critique,
  });
  const subjects = (p.subjects ?? []).map((s) => `${s.class}:${s.confidence}`).join(',');
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} expect=${label.expect.padEnd(8)} ` +
      `got=${j.decision.kind.padEnd(8)} ${j.decision.reason.padEnd(26)} subjects=${subjects}` +
      (c?.verdict ? ` verdict=${c.verdict}` : ''),
  );
}
const passed = results.filter((r) => r.pass).length;
const actionsOnLogFrames = results.filter(
  (r) => r.expect === 'log' && (r.got === 'intruder' || r.got === 'wildlife'),
).length;
console.log(
  `\n${passed}/${results.length} as expected; actions on frames labeled log: ${actionsOnLogFrames}`,
);
const out = join(dir, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2), { mode: 0o600 });
console.log(`details: ${out}`);
