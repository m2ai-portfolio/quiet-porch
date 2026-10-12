import { describe, expect, it, vi } from 'vitest';
import { assessConfiguration, createSourceGuard, type FrictionRecord } from '../src/encryption.ts';
import { openDb } from '../src/db.ts';
import { createPipeline, parsePipelineConfig } from '../src/pipeline.ts';
import { buildLedger, formatLedgerLine } from '../src/ledger.ts';
import type { MotionEvent } from '../src/frames.ts';

const cfgBody = (enabled: unknown) => ({
  data: { attributes: { e2e_encryption: { enabled }, motion_detection: { enabled: 'on' } } },
});

describe('assessConfiguration (Ring documents e2e_encryption.enabled as a boolean)', () => {
  it('reads only an explicit boolean', () => {
    expect(assessConfiguration(200, cfgBody(true))).toBe('blind');
    expect(assessConfiguration(200, cfgBody(false))).toBe('readable');
    expect(assessConfiguration(200, cfgBody('true'))).toBe('unknown');
    expect(assessConfiguration(200, cfgBody(undefined))).toBe('unknown');
    expect(assessConfiguration(200, {})).toBe('unknown');
    expect(assessConfiguration(200, undefined)).toBe('unknown');
    expect(assessConfiguration(403, cfgBody(true))).toBe('unknown');
  });
});

describe('source guard', () => {
  function make(responses: Record<string, { status: number; body?: unknown } | Error>) {
    const friction: FrictionRecord[] = [];
    const guard = createSourceGuard({
      devices: async () => Object.keys(responses).map((d) => ({ accountId: 'acct', deviceId: d })),
      fetchConfig: async (_a, d) => {
        const r = responses[d];
        if (r instanceof Error) throw r;
        return { ...r, requestId: `rid-${d}` };
      },
      friction: (r) => friction.push(r),
      log: () => {},
      now: () => 1000,
    });
    return { guard, friction, responses };
  }

  it('marks an encrypted camera blind and logs one friction record with the request id', async () => {
    const { guard, friction } = make({
      enc: { status: 200, body: cfgBody(true) },
      ok: { status: 200, body: cfgBody(false) },
    });
    await guard.refresh();
    expect(guard.isBlind('enc')).toBe(true);
    expect(guard.isBlind('ok')).toBe(false);
    expect(guard.blindDevices()).toEqual(['enc']);
    expect(guard.sourceMode()).toBe('real');
    const f = friction.find((r) => r.device_id === 'enc')!;
    expect(f).toMatchObject({
      endpoint: 'GET /v1/devices/{device_id}/configurations',
      http_status: 200,
      request_id: 'rid-enc',
    });
    expect(f.finding).toContain('unreadable content');
    await guard.refresh();
    expect(friction).toHaveLength(2); // no new record while nothing changed
  });

  it('logs again when a camera changes state', async () => {
    const { guard, friction, responses } = make({ cam: { status: 200, body: cfgBody(false) } });
    await guard.refresh();
    responses.cam = { status: 200, body: cfgBody(true) };
    await guard.refresh();
    expect(friction.map((r) => r.finding.slice(0, 31))).toEqual([
      'e2e_encryption.enabled is false',
      'e2e_encryption.enabled is true:',
    ]);
    expect(guard.isBlind('cam')).toBe(true);
  });

  it('when every camera is blind it reports that the sandbox is needed', async () => {
    const { guard } = make({ a: { status: 200, body: cfgBody(true) } });
    expect(guard.sourceMode()).toBe('unknown'); // nothing read yet
    await guard.refresh();
    expect(guard.sourceMode()).toBe('sandbox_needed');
  });

  it('an unreadable configuration is "unknown": logged, not blind, and a thrown error is survived', async () => {
    const { guard, friction } = make({
      denied: { status: 403, body: { error: 'x' } },
      down: new Error('ECONNRESET'),
    });
    await guard.refresh();
    expect(guard.isBlind('denied')).toBe(false);
    expect(guard.states().map((s) => s.video)).toEqual(['unknown', 'unknown']);
    expect(friction).toHaveLength(2);
    expect(friction[0].finding).toContain('not readable (HTTP 403)');
  });

  it('a failed device list leaves the earlier states alone', async () => {
    let fail = false;
    const guard = createSourceGuard({
      devices: async () => {
        if (fail) throw new Error('boom');
        return [{ accountId: 'a', deviceId: 'd' }];
      },
      fetchConfig: async () => ({ status: 200, body: cfgBody(true) }),
      friction: () => {},
      log: () => {},
    });
    await guard.refresh();
    fail = true;
    await guard.refresh();
    expect(guard.isBlind('d')).toBe(true);
  });
});

describe('pipeline with a blind camera', () => {
  const EVENT_TS = Date.parse('2026-10-08T23:00:00-05:00');
  const ev: MotionEvent = {
    accountId: 'acct',
    deviceId: 'cam-enc',
    eventId: 'blind-1',
    subType: 'human',
    eventTs: EVENT_TS,
    receivedAt: EVENT_TS + 1000,
  };
  const cfg = parsePipelineConfig({
    dryRun: true,
    timezone: 'America/Chicago',
    nightWindow: { start: '20:00', end: '06:30' },
    zones: { 'cam-enc': 'front_door' },
    context: {
      mode: 'night',
      knownPets: [],
      expectedVisitors: [],
      routines: [],
      nuisanceSpecies: [],
    },
    followUpProbe: false,
  });

  it('requests no frame and asks no model; the ledger line says blind', async () => {
    const db = openDb(':memory:');
    const download = vi.fn();
    const converse = vi.fn();
    const seen: string[] = [];
    const pipeline = createPipeline(cfg, {
      db,
      download,
      converse,
      killed: () => false,
      isBlind: (d) => d === 'cam-enc',
      writeProbe: () => {},
      writeDecision: (r) => seen.push(`${r.kind}:${r.reason}`),
      saveFrame: () => {},
      clock: { now: () => EVENT_TS + 1500, sleep: async () => {} },
    });
    const body = {
      meta: { account_id: 'acct' },
      data: {
        id: 'blind-1',
        type: 'motion_detected',
        attributes: { source: 'cam-enc', timestamp: EVENT_TS, sub_type: 'human' },
      },
    };
    await pipeline.handle(ev, body);
    expect(download).not.toHaveBeenCalled();
    expect(converse).not.toHaveBeenCalled();
    expect(seen).toEqual(['no_evidence:blind_encrypted']);
    const ledger = buildLedger(db, { from: EVENT_TS - 1000, to: EVENT_TS + 60_000 });
    expect(ledger.counts).toMatchObject({ events: 1, silent: 1, blind: 1, handled: 0 });
    expect(ledger.lines[0].kind).toBe('blind');
    expect(formatLedgerLine(ledger.lines[0], 'America/Chicago')[0]).toContain(
      'blind: camera video is encrypted',
    );
    db.close();
  });
});

describe('source guard stability (examiner round 1)', () => {
  const body = (enabled: boolean) => ({ data: { attributes: { e2e_encryption: { enabled } } } });

  it('a blind camera stays blind through one failed read, and flips only on an explicit readable', async () => {
    let next: { status: number; body?: unknown } = { status: 200, body: body(true) };
    const guard = createSourceGuard({
      devices: async () => [{ accountId: 'a', deviceId: 'd' }],
      fetchConfig: async () => next,
      friction: () => {},
      log: () => {},
    });
    await guard.refresh();
    next = { status: 500 };
    await guard.refresh();
    expect(guard.isBlind('d')).toBe(true);
    expect(guard.states()[0].http_status).toBe(500);
    next = { status: 200, body: body(false) };
    await guard.refresh();
    expect(guard.isBlind('d')).toBe(false);
  });

  it('overlapping refreshes share one run', async () => {
    let calls = 0;
    const guard = createSourceGuard({
      devices: async () => [{ accountId: 'a', deviceId: 'd' }],
      fetchConfig: async () => {
        calls++;
        return { status: 200, body: body(true) };
      },
      friction: () => {},
      log: () => {},
    });
    await Promise.all([guard.refresh(), guard.refresh(), guard.refresh()]);
    expect(calls).toBe(1);
    expect(guard.isBlind('d')).toBe(true);
  });
});
