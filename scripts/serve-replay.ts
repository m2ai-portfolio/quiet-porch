// Serve a replayed night to /ledger and /alexa (the video's Plan B on the real pages).
// Usage: node scripts/serve-replay.ts <fixture.json> [--port 3470]
// Read-only by construction: only a read token exists, so stand_down, set_mode and expect_me
// cannot be called. Every answer and the ledger header say "replay, not live" and the fixture
// label. Binds to 127.0.0.1; the tokens are random per run and printed once.
import { randomBytes } from 'node:crypto';
import { createStatusMcp } from '../src/mcp.ts';
import { loadFixture, runReplay } from '../src/replay.ts';
import { arg } from './lib.ts';

const path = process.argv[2];
if (!path || path.startsWith('--')) {
  console.error('usage: node scripts/serve-replay.ts <fixture.json> [--port 3470]');
  process.exit(2);
}
const port = Number(arg('port') ?? 3470);
const fx = loadFixture(path);
const r = await runReplay(fx, { keepDb: true });
const night = fx.config as { timezone: string; nightWindow: { start: string; end: string } };
const tokens = {
  read: randomBytes(18).toString('base64url'),
  owner: randomBytes(24).toString('base64url'), // never printed: nobody can use the owner tools
};
const { server } = createStatusMcp({
  db: r.db!,
  tokens,
  mode: { get: () => fx.mode, set: () => {} },
  killed: () => false,
  dryRun: true,
  standDown: async () => 'not_active',
  clearReconcile: () => false,
  expectMe: () => {
    throw new Error('a replay is read-only');
  },
  cancelExpectation: () => 0,
  night: { timezone: night.timezone, start: night.nightWindow.start, end: night.nightWindow.end },
  source: 'replay',
  sourceLabel: fx.label,
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  log: () => {},
  now: () => r.endedAt,
});
server.listen(port, '127.0.0.1', () => {
  console.log(`*** ${fx.label.toUpperCase()} *** (a replay, not a live night)`);
  console.log(`ledger:  http://127.0.0.1:${port}/ledger`);
  console.log(`alexa:   http://127.0.0.1:${port}/alexa`);
  console.log(`token (read only, paste into the page): ${tokens.read}`);
});
