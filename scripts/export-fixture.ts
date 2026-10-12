// Export a recorded night from the live state directory into a replay fixture (F9).
// Usage: node scripts/export-fixture.ts --from 2026-10-18T01:00:00-05:00 --to 2026-10-18T03:00:00-05:00 \
//          --label "replay of 2026-10-18" --out ~/.local/state/quiet-porch/fixtures/nights/side-gate \
//          [--state-dir dir] [--mode away]
// Writes <out>/fixture.json and <out>/frames/*.jpg. The fixture holds household frames, so it is
// refused inside the repository. The first replay becomes expected_ledger, and the differences
// against the original night's ledger are printed (ages differ by design, see src/replay.ts).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildLedger } from '../src/ledger.ts';
import { compareLedgers, exportFixture } from '../src/export-fixture.ts';
import type { Mode } from '../src/ladder.ts';
import { runReplay } from '../src/replay.ts';
import { arg, configPath, DEFAULT_STATE_DIR, openDbCopy } from './lib.ts';

function need(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

const jsonl = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

const stateDir = arg('state-dir') ?? DEFAULT_STATE_DIR;
const repo = resolve(import.meta.dirname, '..');
const out = resolve(need('out').replace(/^~/, process.env.HOME ?? '~'));
if (!relative(repo, out).startsWith('..')) {
  console.error('refusing to write a fixture (household frames) inside the repository');
  process.exit(2);
}
const from = Date.parse(need('from'));
const to = Date.parse(need('to'));
if (!Number.isFinite(from) || !Number.isFinite(to)) {
  console.error('--from and --to must be ISO times');
  process.exit(2);
}

const config = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown> & {
  context: { mode: Mode };
  coordinator: { allowlist?: string };
  timezone: string;
};
const allowlist = JSON.parse(
  readFileSync(resolve(repo, config.coordinator.allowlist ?? 'config/allowlist.json'), 'utf8'),
);
let mode: Mode = config.context.mode;
try {
  mode = (JSON.parse(readFileSync(join(stateDir, 'mode.json'), 'utf8')) as { mode: Mode }).mode;
} catch {
  /* no live mode file: config mode */
}
mode = (arg('mode') as Mode | undefined) ?? mode;

const probes = jsonl(join(stateDir, 'frame-probe.jsonl'));
const timings = new Map(
  jsonl(join(stateDir, 'decisions.jsonl')).map((d) => [
    String(d.source_event_id),
    d.timings as { perception_ms?: number; critique_ms?: number },
  ]),
);
const db = openDbCopy(stateDir);
const { fixture, frames } = exportFixture(db, {
  from,
  to,
  label: need('label'),
  mode,
  config,
  allowlist,
  hasFrame: (id) => existsSync(join(stateDir, 'frames', `${id}.jpg`)),
  readyAfterEventMs: (device, ts) =>
    probes.find((p) => p.device_id === device && p.event_ts === ts)?.ready_after_event_ms as
      number | undefined,
  modelMs: (id) => {
    const t = timings.get(id);
    return t ? { perception: t.perception_ms, critique: t.critique_ms } : undefined;
  },
});
const original = buildLedger(db, { from, to }).lines;
db.close();

mkdirSync(join(out, 'frames'), { recursive: true, mode: 0o700 });
for (const f of frames) copyFileSync(join(stateDir, f.file), join(out, f.file));
const replay = await runReplay({ ...fixture });
fixture.expected_ledger = replay.lines;
writeFileSync(join(out, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });

console.log(
  `wrote ${join(out, 'fixture.json')} (${fixture.events.length} events, ${frames.length} frames kept)`,
);
console.log(
  `frames not on disk are replayed as placeholders: ${fixture.events.length - frames.length} events`,
);
const diffs = compareLedgers(original, replay.ledger.lines);
console.log(
  diffs.length
    ? `replay differs from the original night in ${diffs.length} line(s):\n${diffs.join('\n')}`
    : 'replay matches the original night line for line (time, what, level, stop reason)',
);
console.log(`verify: node scripts/replay.ts ${join(out, 'fixture.json')}`);
