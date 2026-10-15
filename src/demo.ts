// Synthetic-only rehearsal server: no Ring, Bedrock, Polly, HA, SSH or notifier credential path.
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixture, runReplay, type ReplayResult } from './replay.ts';
import { buildLedger, formatLedger } from './ledger.ts';
import { nightReport } from './report.ts';
import { latestNightWindow } from './nightwindow.ts';
import { recordEvent, recordDecision } from './db.ts';
import { ingestionHealth } from './ingestion-health.ts';

export async function createDemoServer(opts: { stateDir: string; fixturePath?: string }) {
  const base = loadFixture(
    opts.fixturePath ??
      new URL('../test/fixtures/synthetic-speech-night.json', import.meta.url).pathname,
  );
  if (!base.synthetic) throw Error('demo accepts synthetic fixtures only');
  mkdirSync(opts.stateDir, { recursive: true });
  const statePath = join(opts.stateDir, 'rehearsal.json');
  let saved: { scenario: string; note: string; stopped: boolean; expected: boolean } = {
    scenario: 'night',
    note: '',
    stopped: false,
    expected: false,
  };
  if (existsSync(statePath)) {
    try {
      saved = { ...saved, ...JSON.parse(readFileSync(statePath, 'utf8')) };
    } catch {
      /* recover from corrupt preference file */
    }
  }
  const scenarios = ['night', 'active', 'empty', 'historical', 'secondary'];
  if (!scenarios.includes(saved.scenario)) saved.scenario = 'night';
  let r: ReplayResult;
  const cfg = base.config as { timezone: string; nightWindow: { start: string; end: string } };
  function ledger() {
    const span = latestNightWindow(
      r.endedAt,
      cfg.nightWindow.start,
      cfg.nightWindow.end,
      cfg.timezone,
    );
    const l = buildLedger(r.db!, span, { source: 'replay' });
    const before = performance.now();
    const report = nightReport(l, span, {
      timezone: cfg.timezone,
      start: cfg.nightWindow.start,
      end: cfg.nightWindow.end,
      dryRun: true,
      source: 'replay',
    });
    const latencyMs = performance.now() - before;
    return {
      scenario: saved.scenario,
      label: 'SYNTHETIC REPLAY — NOT LIVE; NO PHYSICAL OUTPUTS',
      ledger: l,
      textLines: formatLedger(l.lines, cfg.timezone),
      report,
      reportLatencyMs: latencyMs,
      health: ingestionHealth(r.db!, r.endedAt),
      note: saved.note,
      active: r.db!.prepare("SELECT id,level FROM incidents WHERE status='active'").get() ?? null,
      expected: saved.expected,
    };
  }
  function persist() {
    writeFileSync(statePath + '.tmp', JSON.stringify(saved, null, 2) + '\n');
    renameSync(statePath + '.tmp', statePath);
    writeFileSync(
      join(opts.stateDir, 'last-ledger.json'),
      JSON.stringify(ledger(), null, 2) + '\n',
    );
  }
  async function rebuild() {
    if (r?.db) r.db.close();
    const fixture = structuredClone(base);
    fixture.expected_ledger = undefined;
    if (saved.scenario === 'active') {
      fixture.events = fixture.events.filter(
        (e) => e.received_at <= fixture.events[2].received_at + 20000,
      );
      fixture.settle_ms = 0;
    }
    if (['empty', 'historical'].includes(saved.scenario))
      fixture.events = fixture.events
        .slice(0, 1)
        .map((e) => ({
          ...e,
          webhook: {
            ...(e.webhook as object),
            data: { ...(e.webhook as { data: object }).data, id: 'seed-noop' },
          },
        }));
    if (saved.scenario === 'secondary') {
      const first = fixture.events[0];
      fixture.events = [
        first,
        ...fixture.events
          .slice(2, 5)
          .map((e) => ({
            ...e,
            webhook: {
              ...(e.webhook as object),
              meta: { account_id: 'secondary-synthetic', request_id: 'secondary-' + e.received_at },
              data: {
                ...(e.webhook as { data: object }).data,
                id: 'secondary-' + e.received_at,
                attributes: {
                  ...(e.webhook as { data: { attributes: object } }).data.attributes,
                  source: 'second-camera',
                },
              },
            },
          })),
      ];
      (fixture.config.zones as Record<string, string>)['second-camera'] = 'front_yard';
    }
    r = await runReplay(fixture, { keepDb: true });
    if (saved.scenario === 'empty') r.db!.exec('DELETE FROM decisions; DELETE FROM events;');
    if (saved.scenario === 'historical') {
      recordEvent(
        r.db!,
        {
          source: 'ring',
          sourceEventId: 'historical-missing',
          type: 'motion_detected',
          zone: 'front_yard',
          payload: {
            meta: { account_id: 'acct-synthetic' },
            data: { attributes: { timestamp: fixture.events[0].received_at, source: 'cam-yard' } },
          },
        },
        fixture.events[0].received_at,
      );
      recordDecision(
        r.db!,
        {
          sourceEventId: 'historical-missing',
          zone: 'front_yard',
          kind: 'intruder',
          reason: 'legacy_actionable',
          dryRun: true,
        },
        fixture.events[0].received_at,
      );
    }
    if (saved.stopped) {
      const inc = r.db!.prepare("SELECT id FROM incidents WHERE status='active'").get() as
        { id: number } | undefined;
      if (inc) await r.coordinator!.standDown(inc.id, 'rehearsal');
    }
    if (saved.expected) {
      r.coordinator!.expectMe('expected visitor', 10, 'rehearsal');
      await r.coordinator!.idle();
    }
  }
  await rebuild();
  persist();
  let queue = Promise.resolve();
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw Error('body too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  const server = createServer((req, res) => {
    const run = queue.then(async () => {
      const url = new URL(req.url ?? '/', 'http://rehearsal.invalid');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(readFileSync(new URL('./demo.html', import.meta.url)));
        return;
      }
      const assets: Record<string, string> = {
        '/assets/wildlife.mp4': '../demo/assets/wildlife-synthetic.mp4',
        '/assets/rehearsal.mp4': '../demo/assets/rehearsal-cut.mp4',
        '/assets/thumbnail.svg': '../demo/assets/thumbnail.svg',
        '/delivery': '../docs/delivery/coverage.html',
        '/submission': '../docs/delivery/submission.html',
      };
      if (req.method === 'GET' && assets[url.pathname]) {
        res.setHeader(
          'Content-Type',
          url.pathname.endsWith('.mp4')
            ? 'video/mp4'
            : url.pathname.endsWith('.svg')
              ? 'image/svg+xml'
              : 'text/html; charset=utf-8',
        );
        res.end(readFileSync(new URL(assets[url.pathname], import.meta.url)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(ledger()));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
          res.statusCode = 403;
          res.end('Origin denied');
          return;
        }
        const input = await body(req);
        if (input.action === 'scenario') {
          if (!scenarios.includes(String(input.scenario))) throw Error('unknown scenario');
          saved = { ...saved, scenario: String(input.scenario), stopped: false, expected: false };
          await rebuild();
        } else if (input.action === 'stop') {
          const inc = r.db!.prepare("SELECT id FROM incidents WHERE status='active'").get() as
            { id: number } | undefined;
          if (inc) await r.coordinator!.standDown(inc.id, 'rehearsal');
          saved.stopped = true;
        } else if (input.action === 'expect') {
          r.coordinator!.expectMe('expected visitor', 10, 'rehearsal');
          await r.coordinator!.idle();
          saved.expected = true;
        } else if (input.action === 'cancel') {
          r.coordinator!.cancelExpectation('rehearsal');
          saved.expected = false;
        } else if (input.action === 'note') {
          if (typeof input.note !== 'string' || input.note.length > 2000)
            throw Error('invalid note');
          saved.note = input.note;
        } else throw Error('unknown action');
        persist();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(ledger()));
        return;
      }
      res.statusCode = 404;
      res.end('Not found');
    });
    queue = run.catch(() => {});
    void run.catch(() => {
      res.statusCode = 400;
      res.end('Invalid rehearsal request');
    });
  });
  return { server, close: () => r.db!.close() };
}
