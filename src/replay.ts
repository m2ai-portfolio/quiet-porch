// Night fixture replay (F9). A fixture is a recorded incident: the original webhook bodies and
// frames with their Ring timestamps, and the model answers Bedrock gave. Replaying it runs the
// REAL pipeline, ladder and coordinator (dry-run actuators) on a virtual clock, with the model
// and the Ring download replaced by the recording. The same fixture therefore produces the same
// ledger every time, which makes it the cold-start rehearsal and the video's Plan B.
//
// Honesty rules: the ledger of a replay says "source replay", and the fixture's label
// ("replay of 2026-10-xx") is shown wherever the ledger is shown. A replay never claims to be live.
//
// Known limit: events replay one after another. The live pipeline overlaps events, so evidence
// ages in a replay are the sequential ones; the exporter prints the differences against the
// original ledger instead of hiding them.
import { readFileSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, resolve, sep } from 'node:path';
import { createDryRunActuators } from './actuators.ts';
import { parseAllowlist } from './allowlist.ts';
import type { ContentBlock } from './bedrock.ts';
import { createCoordinator, parseCoordinatorSection } from './coordinator.ts';
import { openDb } from './db.ts';
import { parseMotionEvent, type Download } from './frames.ts';
import type { Mode } from './ladder.ts';
import { buildLedger, formatLedger, type Ledger } from './ledger.ts';
import { latestNightWindow } from './nightwindow.ts';
import { createPipeline, parsePipelineConfig } from './pipeline.ts';

export interface FixtureFrame {
  ts_ring: number;
  file?: string; // relative to the fixture file
  base64?: string;
}

export interface FixtureEvent {
  received_at: number; // when the webhook originally arrived
  webhook: unknown; // the original body
  frames: FixtureFrame[];
  ready_after_event_ms?: number; // recording not downloadable before this (probe data)
  model: {
    perception?: Record<string, unknown> | null;
    critique?: Record<string, unknown> | null;
    perception_ms?: number;
    critique_ms?: number;
  };
}

export interface Fixture {
  version: 1;
  label: string; // burned into every view of the replay, e.g. "replay of 2026-10-12"
  synthetic?: boolean; // true for a hand-built fixture; a real night leaves it out
  mode: Mode;
  config: Record<string, unknown>; // pipeline fields + coordinator section, as config/quiet-porch.json
  allowlist: unknown;
  events: FixtureEvent[];
  settle_ms?: number; // virtual time run after the last event (default 6 minutes)
  expected_ledger?: string[];
}

export interface ReplayResult {
  ledger: Ledger;
  lines: string[];
  timezone: string;
  db?: DatabaseSync; // only with keepDb; the caller closes it
  endedAt: number; // virtual time when the replay finished
}

const DEFAULT_SETTLE_MS = 6 * 60_000;
const TICK_MS = 1000;
const QUIET_JUMP_MS = 6 * 60_000; // after this long with nothing running, jump the clock

export function loadFixture(path: string): Fixture {
  const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  if (fx.version !== 1 || !Array.isArray(fx.events) || typeof fx.label !== 'string') {
    throw new Error(`${path}: not a version 1 fixture`);
  }
  if (!['home', 'away', 'night'].includes(fx.mode)) {
    throw new Error(`${path}: mode must be home, away or night, got "${String(fx.mode)}"`);
  }
  fx.events.forEach((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`${path}: event ${i} is not an object`);
    if (!Array.isArray(e.frames)) throw new Error(`${path}: event ${i} has no frames array`);
    if (!e.model || typeof e.model !== 'object')
      throw new Error(`${path}: event ${i} has no model`);
    if (!Number.isFinite(e.received_at)) throw new Error(`${path}: event ${i} has no received_at`);
    if (i > 0 && e.received_at < fx.events[i - 1].received_at) {
      throw new Error(
        `${path}: event ${i} is earlier than event ${i - 1}; events must be in order`,
      );
    }
    if (!parseMotionEvent(e.webhook, e.received_at)) {
      throw new Error(`${path}: event ${i} is not a motion_detected webhook`);
    }
  });
  const dir = dirname(resolve(path));
  for (const e of fx.events) {
    for (const f of e.frames) {
      if (!f || typeof f !== 'object')
        throw new Error(`${path}: a frame of an event is not an object`);
      if (f.file && !f.base64) {
        if (typeof f.file !== 'string')
          throw new Error(`${path}: a frame file name must be a string`);
        const full = resolve(dir, f.file);
        // A fixture is data: its frame files must live inside its own folder.
        const outside = () =>
          new Error(`${path}: frame file ${String(f.file)} is outside the fixture folder`);
        // Lexical check first (a ../ or absolute name never touches the disk), then the real
        // path, so a symlink inside the folder that points out is refused too.
        if (typeof f.file !== 'string' || (!full.startsWith(dir + sep) && full !== dir)) {
          throw outside();
        }
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          throw new Error(`${path}: frame file ${f.file} cannot be read`);
        }
        const realDir = realpathSync(dir);
        if (!real.startsWith(realDir + sep) && real !== realDir) throw outside();
        f.base64 = readFileSync(full).toString('base64');
      }
    }
  }
  return fx;
}

// One shared virtual time. The pipeline's sleep jumps it forward at once (it only waits for
// frame retries); the coordinator's sleep is timer-driven so its 3 s call deadline can still
// lose a race to a call that answers at once.
function virtualClock(start: number) {
  let t = start;
  const timers: { at: number; wake: () => void }[] = [];
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    now: () => t,
    jumpTo: (to: number) => void (t = Math.max(t, to)),
    pipelineClock: {
      now: () => t,
      sleep: async (ms: number) => void (t += Math.max(0, ms)),
    },
    coordClock: {
      now: () => t,
      sleep: (ms: number) => new Promise<void>((wake) => timers.push({ at: t + ms, wake })),
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.wake();
        await flush();
      }
      t = Math.max(t, end);
      await flush();
    },
  };
}

// A placeholder frame body for a fixture frame that was not saved (only intruder and wildlife
// frames are kept live). Deterministic, so evidence ids repeat.
function frameBytes(f: FixtureFrame): Buffer {
  if (f.base64) return Buffer.from(f.base64, 'base64');
  return Buffer.from([0xff, 0xd8, ...Buffer.from(String(f.ts_ring))]);
}

export async function runReplay(
  fx: Fixture,
  opts: { keepDb?: boolean } = {},
): Promise<ReplayResult> {
  if (fx.events.length === 0) throw new Error('fixture has no events');
  const db = openDb(':memory:');
  const vc = virtualClock(fx.events[0].received_at);
  const allowlist = parseAllowlist(fx.allowlist);
  const pipeCfg = parsePipelineConfig({ ...fx.config, dryRun: true });
  const coordCfg = parseCoordinatorSection(
    fx.config.coordinator,
    allowlist,
    fx.mode,
    pipeCfg.wildlifeMaxEvidenceAgeMs,
  );
  const actuators = createDryRunActuators(() => {}, vc.coordClock);
  const coordinator = createCoordinator(coordCfg, {
    db,
    allowlist,
    actuators,
    killed: () => false,
    log: () => {},
    stopUrl: (id) => `${coordCfg.publicBase}/stop?i=${id}`,
    clock: vc.coordClock,
    mode: () => fx.mode,
  });
  await coordinator.boot();

  let current: FixtureEvent = fx.events[0];
  const download: Download = async (_account, _device, timestampMs) => {
    const frame = current.frames.find((f) => Math.abs(f.ts_ring - timestampMs) <= 1000);
    const eventTs = (current.webhook as { data: { attributes: { timestamp: number } } }).data
      .attributes.timestamp;
    const notReady =
      current.ready_after_event_ms !== undefined &&
      vc.now() - eventTs < current.ready_after_event_ms;
    if (!frame || notReady) return { status: 416, step: 2, error_code: 'MEDIA_NOT_FOUND' };
    const image = frameBytes(frame);
    return {
      status: 200,
      step: 2,
      content_type: 'image/jpeg',
      bytes: image.length,
      media_timestamp: frame.ts_ring,
      media_origin: 'recording',
      image,
    };
  };
  const converse = async (content: ContentBlock[]): Promise<string> => {
    const isPerception = content.some((c) => 'image' in c);
    const text = content.map((c) => ('text' in c ? c.text : '')).join('');
    const id = /"evidence_id": "(ev_[0-9a-f]+)"/.exec(text)?.[1];
    const body = isPerception ? current.model.perception : current.model.critique;
    const ms = (isPerception ? current.model.perception_ms : current.model.critique_ms) ?? 0;
    await vc.pipelineClock.sleep(ms);
    if (!body || 'error' in body) return 'the model returned no usable JSON';
    // Bedrock wraps JSON in a code fence (recon); the replay keeps that quirk.
    return '```json\n' + JSON.stringify({ ...body, evidence_id: id }) + '\n```';
  };

  const pipeline = createPipeline(pipeCfg, {
    db,
    download,
    converse,
    killed: () => false,
    writeProbe: () => {},
    writeDecision: () => {},
    saveFrame: () => {},
    onEvaluation: (ev) => void coordinator.onEvaluation(ev),
    mode: () => fx.mode,
    clock: vc.pipelineClock,
  });

  // Run virtual time forward, ticking the coordinator each second while anything may be running.
  async function runUntil(target: number): Promise<void> {
    const from = vc.now();
    while (vc.now() < target) {
      if (vc.now() - from > QUIET_JUMP_MS) {
        await vc.advance(target - vc.now());
        await coordinator.tick();
        break;
      }
      await vc.advance(Math.min(TICK_MS, target - vc.now()));
      await coordinator.tick();
    }
  }

  for (const e of fx.events) {
    await runUntil(e.received_at);
    vc.jumpTo(e.received_at);
    current = e;
    const motion = parseMotionEvent(e.webhook, e.received_at);
    if (!motion) throw new Error('fixture event is not a motion_detected webhook');
    await pipeline.handle(motion, e.webhook);
    await coordinator.idle();
    await coordinator.tick();
  }
  await runUntil(vc.now() + (fx.settle_ms ?? DEFAULT_SETTLE_MS));
  await coordinator.idle();

  const first = fx.events[0].received_at;
  const cfg = pipeCfg;
  const span = latestNightWindow(
    vc.now(),
    cfg.nightWindow.start,
    cfg.nightWindow.end,
    cfg.timezone,
  );
  // The fixture may be outside its own night window (a daytime test); then show all of it.
  const covers = first >= span.from && first <= span.to;
  const range = covers ? span : { from: first - 3_600_000, to: vc.now() };
  const ledger = buildLedger(db, range, { source: 'replay' });
  if (!opts.keepDb) db.close();
  return {
    ledger,
    lines: formatLedger(ledger.lines, cfg.timezone),
    timezone: cfg.timezone,
    endedAt: vc.now(),
    ...(opts.keepDb ? { db } : {}),
  };
}

export interface ReplayCheck {
  ok: boolean;
  runs: string[][];
  problems: string[];
}

// The F9 acceptance: N runs in a row produce the same ledger lines, equal to the fixture's own.
export async function checkReplay(fx: Fixture, times = 3): Promise<ReplayCheck> {
  const runs: string[][] = [];
  for (let i = 0; i < times; i++) runs.push((await runReplay(fx)).lines);
  const problems: string[] = [];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);
  runs.forEach((r, i) => {
    if (!same(r, runs[0])) problems.push(`run ${i + 1} differs from run 1`);
  });
  if (fx.expected_ledger && !same(runs[0], fx.expected_ledger)) {
    problems.push('run 1 differs from the fixture expected_ledger');
  }
  if (!fx.expected_ledger) problems.push('fixture has no expected_ledger to compare against');
  return { ok: problems.length === 0, runs, problems };
}
