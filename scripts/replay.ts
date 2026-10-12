// Replay a night fixture through the full pipeline and print its ledger (F9).
// Usage: node scripts/replay.ts <fixture.json> [--times 3] [--write-expected]
//   exit 0: every run produced the same ledger and it equals the fixture's expected_ledger
//   exit 1: a run differed, or the ledger changed since the fixture was written
// --write-expected stores the first run as the fixture's expected_ledger (re-blessing).
import { readFileSync, writeFileSync } from 'node:fs';
import { checkReplay, loadFixture } from '../src/replay.ts';
import { arg } from './lib.ts';

const path = process.argv[2];
if (!path || path.startsWith('--')) {
  console.error('usage: node scripts/replay.ts <fixture.json> [--times 3] [--write-expected]');
  process.exit(2);
}
const times = Number(arg('times') ?? 3);
const fx = loadFixture(path);
const banner = fx.label.toUpperCase();
console.log(`*** ${banner} ***   (a replay, not a live night)`);
const check = await checkReplay(fx, times);
console.log(check.runs[0].join('\n'));
console.log('-'.repeat(60));
if (process.argv.includes('--write-expected')) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.expected_ledger = check.runs[0];
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  console.log('expected_ledger written; run again without --write-expected to verify');
  process.exit(0);
}
console.log(
  check.ok
    ? `OK: ${times} runs in a row produced the same ledger as the fixture`
    : `FAILED: ${check.problems.join('; ')}`,
);
process.exit(check.ok ? 0 : 1);
