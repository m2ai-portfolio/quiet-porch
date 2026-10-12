// Terminal view of the night ledger (F8): the same lines the /ledger page shows, read from a
// copy of the live database. Usage: node scripts/ledger.ts [--state-dir dir]
import { readFileSync } from 'node:fs';
import { buildLedger, formatLedger } from '../src/ledger.ts';
import { latestNightWindow, localDate } from '../src/nightwindow.ts';
import { parsePipelineConfig } from '../src/pipeline.ts';
import { arg, configPath, DEFAULT_STATE_DIR, openDbCopy } from './lib.ts';

const cfg = parsePipelineConfig(JSON.parse(readFileSync(configPath(), 'utf8')));
const db = openDbCopy(arg('state-dir') ?? DEFAULT_STATE_DIR);
const span = latestNightWindow(
  Date.now(),
  cfg.nightWindow.start,
  cfg.nightWindow.end,
  cfg.timezone,
);
const ledger = buildLedger(db, span);
const c = ledger.counts;
console.log(
  `Quiet Porch night ledger · night of ${localDate(span.from, cfg.timezone)} (${cfg.nightWindow.start} to ${cfg.nightWindow.end}, ${cfg.timezone})` +
    (span.inProgress ? ' · night in progress' : ''),
);
console.log('-'.repeat(60));
console.log(
  ledger.lines.length
    ? formatLedger(ledger.lines, cfg.timezone).join('\n')
    : 'No events. Silent all night.',
);
console.log('-'.repeat(60));
console.log(`${c.events} events · ${c.silent} silent · ${c.handled} handled`);
db.close();
