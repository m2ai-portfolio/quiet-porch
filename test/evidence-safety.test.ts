import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatusTools } from '../src/mcp.ts';
import { openDb, recordEvent, recordDecision } from '../src/db.ts';
import { buildLedger } from '../src/ledger.ts';
import { nightReport } from '../src/report.ts';
import { householdAccess } from '../src/household.ts';
import { ingestionHealth } from '../src/ingestion-health.ts';
import { loadAllowlist, checkAction } from '../src/allowlist.ts';
import { createSpeechOutput, pcmWav } from '../src/speech.ts';
import { approvedSpeech, composeLine } from '../src/voice.ts';
import { createLiveSource, createWhepSignaling, type LiveFrame } from '../src/live-source.ts';
const allow = loadAllowlist(new URL('../config/allowlist.json', import.meta.url).pathname);

describe('zone and household boundaries', () => {
  it('unconfigured households never become actuator owners by arrival order', () => {
    const db = openDb(':memory:');
    expect(householdAccess(db, 'unknown', 'configured-device', true)).toBe('ledger_only');
    db.close();
  });
  it('secondary MCP surface exposes only scoped ledger/report tools, even with owner token', () => {
    const db = openDb(':memory:');
    const tools = createStatusTools({
      db,
      accountId: 'secondary',
      readOnlyHousehold: true,
      tokens: { read: 'r', owner: 'o' },
      mode: { get: () => 'away', set: () => {} },
      killed: () => false,
      dryRun: true,
      standDown: async () => 'not_active',
      clearReconcile: () => false,
      expectMe: () => {
        throw Error('must not run');
      },
      cancelExpectation: () => 0,
      allowedOrigins: [],
      log: () => {},
    });
    expect(tools.map((t) => t.name)).toEqual(['get_night_report', 'get_ledger']);
    db.close();
  });

  it('rejects missing/wrong zones and permits cleanup after context loss', () => {
    const req = { entity_id: 'valve.front_yard_sprinkler_valve', service: 'open_valve' };
    expect(checkAction(allow, req).ok).toBe(false);
    expect(checkAction(allow, { ...req, zone: 'back_yard' }).ok).toBe(false);
    expect(checkAction(allow, { ...req, zone: 'front_yard' }).ok).toBe(true);
    expect(checkAction(allow, { ...req, service: 'close_valve', zone: 'changed' }).ok).toBe(true);
  });
  it('binds devices once and secondary accounts are ledger-only after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qp-household-'));
    const path = join(dir, 'db');
    let db = openDb(path);
    expect(householdAccess(db, 'primary', 'cam1', true, 'primary')).toBe('primary');
    expect(householdAccess(db, 'second', 'cam2', true, 'primary')).toBe('ledger_only');
    expect(householdAccess(db, 'second', 'cam1', true, 'primary')).toBe('mismatch');
    db.close();
    db = openDb(path);
    expect(householdAccess(db, 'second', 'cam2', true, 'primary')).toBe('ledger_only');
    expect(householdAccess(db, 'third', 'unknown', false)).toBe('unmapped');
    db.close();
    rmSync(dir, { recursive: true });
  });
  it('keeps account-filtered ledger rows separate and records incomplete outcomes honestly', () => {
    const db = openDb(':memory:');
    for (const account of ['first', 'second']) {
      recordEvent(
        db,
        {
          source: 'ring',
          sourceEventId: account,
          type: 'motion_detected',
          payload: {
            meta: { account_id: account },
            data: { attributes: { timestamp: 100, source: account } },
          },
        },
        101,
      );
      recordDecision(
        db,
        {
          sourceEventId: account,
          zone: 'front_yard',
          kind: 'intruder',
          reason: 'person_unknown',
          dryRun: true,
        },
        102,
      );
    }
    const ledger = buildLedger(db, { from: 0, to: 200 }, { accountId: 'first' });
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0].device_id).toBe('first');
    expect(ledger.counts.unknown).toBe(1);
    expect(ledger.counts.silent).toBe(0);
    expect(
      nightReport(
        ledger,
        { from: 0, to: 200, inProgress: false },
        { timezone: 'America/Chicago', start: '20:00', end: '06:30', dryRun: true },
      ).text,
    ).toContain('outcomes unknown');
    db.close();
  });
  it('does not equate absent/recent events with proven healthy coverage', () => {
    const db = openDb(':memory:');
    expect(ingestionHealth(db, 200).status).toBe('unknown');
    recordEvent(
      db,
      { source: 'ring', sourceEventId: 'e', type: 'motion_detected', payload: {} },
      100,
    );
    expect(ingestionHealth(db, 200).status).toBe('recent');
    expect(ingestionHealth(db, 4_000_000).status).toBe('gap');
    db.close();
  });
});

describe('speech output and truthful content', () => {
  it('removes the owner-notified claim unless a notification completed', () => {
    expect(composeLine({ place: 'side gate' }, { ownerNotified: false }).text).toBe(
      "You're on camera at the side gate.",
    );
    expect(approvedSpeech("You're on camera. The owner has been notified.", false)).toBe(false);
    expect(approvedSpeech("You're on camera. Please step back.", false)).toBe(false);
    expect(
      approvedSpeech(composeLine({ clothing: 'white shirt' }, { ownerNotified: true }).text, true),
    ).toBe(true);
  });
  it('validates fixed speech again at the allowlist', () => {
    const req = {
      entity_id: 'pi_audio.porch_speaker',
      zone: 'front_yard',
      service: 'speak',
      data: { spoken_text: "You're on camera.", owner_notified: false },
    };
    expect(checkAction(allow, req).ok).toBe(true);
    expect(
      checkAction(allow, { ...req, data: { ...req.data, spoken_text: 'Police are coming.' } }).ok,
    ).toBe(false);
  });
  it('caches exact finite audio and uses the matching truthful fallback after provider failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qp-speech-'));
    const synth = vi.fn(async () => Buffer.alloc(3200));
    const play = vi.fn(async () => {});
    const output = createSpeechOutput({ cacheDir: dir, synthesize: synth, play, now: () => 100 });
    await output.prepareFallbacks();
    synth.mockRejectedValue(new Error('offline'));
    const result = await output.speak("You're on camera at the side gate.", false, 'intent-1', 100);
    expect(result).toMatchObject({ ok: true, fallback: true, spokenText: "You're on camera." });
    expect(play).toHaveBeenCalledOnce();
    rmSync(dir, { recursive: true });
  });
  it('fails rather than pretending playback when fallback is absent or speaker fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qp-speech-'));
    const output = createSpeechOutput({
      cacheDir: dir,
      synthesize: async () => {
        throw Error('offline');
      },
      play: async () => {},
      now: () => 100,
    });
    expect(await output.speak("You're on camera.", false, 'i', 100)).toMatchObject({
      ok: false,
      error: 'cached_fallback_unavailable',
    });
    const unavailable = createSpeechOutput({
      cacheDir: dir,
      synthesize: async () => Buffer.alloc(3200),
      play: async () => {
        throw Error('speaker');
      },
      now: () => 100,
    });
    expect(await unavailable.speak("You're on camera.", false, 'i', 100)).toMatchObject({
      ok: false,
      error: 'speech_playback_failed',
    });
    rmSync(dir, { recursive: true });
  });
  it('rejects long audio and expired intents', async () => {
    expect(() => pcmWav(Buffer.alloc(128002))).toThrow('duration');
    const dir = mkdtempSync(join(tmpdir(), 'qp-speech-'));
    const play = vi.fn(async () => {});
    const output = createSpeechOutput({
      cacheDir: dir,
      synthesize: async () => Buffer.alloc(3200),
      play,
      now: () => 4000,
    });
    expect(await output.speak("You're on camera.", false, 'i', 0)).toMatchObject({
      ok: false,
      error: 'speech_expired',
    });
    expect(play).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true });
  });
});

describe('live-source session and provenance', () => {
  const frame = (ts: number): LiveFrame => ({
    jpeg: Buffer.from([255, 216, 1]),
    captureTs: ts,
    timestampAuthority: 'ring',
    accountId: 'a',
    deviceId: 'd',
  });
  it('reopens battery sessions at 30 seconds, accepts fresh monotonic frames and stops', async () => {
    let now = 1000;
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({ read: async () => frame(now - 10), close }));
    const source = createLiveSource({
      transport: { open },
      accountId: 'a',
      deviceId: 'd',
      battery: true,
      now: () => now,
    });
    expect(await source.poll()).toBeDefined();
    now += 30000;
    expect(await source.poll()).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    await source.stop();
    expect(source.latest()).toBeUndefined();
    expect(await source.poll()).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });
  it.each(['arrival', 'stale', 'future', 'household', 'jpeg'])(
    'rejects %s evidence and leaves clip fallback',
    async (kind) => {
      const f = frame(100);
      if (kind === 'arrival') f.timestampAuthority = 'arrival';
      if (kind === 'stale') f.captureTs = -10000;
      if (kind === 'future') f.captureTs = 500;
      if (kind === 'household') f.accountId = 'other';
      if (kind === 'jpeg') f.jpeg = Buffer.from('not jpeg');
      const source = createLiveSource({
        transport: { open: async () => ({ read: async () => f, close: async () => {} }) },
        accountId: 'a',
        deviceId: 'd',
        battery: true,
        now: () => 200,
      });
      expect(await source.poll()).toBeUndefined();
      expect(source.latest()).toBeUndefined();
      await source.stop();
    },
  );
  it('keeps monotonic capture ordering after an invalid frame', async () => {
    const samples = [frame(100), frame(90), frame(95), frame(110)];
    const source = createLiveSource({
      transport: {
        open: async () => ({ read: async () => samples.shift(), close: async () => {} }),
      },
      accountId: 'a',
      deviceId: 'd',
      battery: true,
      now: () => 200,
    });
    expect(await source.poll()).toBeDefined();
    expect(await source.poll()).toBeUndefined();
    expect(await source.poll()).toBeUndefined();
    expect((await source.poll())?.captureTs).toBe(110);
    await source.stop();
  });
  it('recovers after transport failure without retaining old evidence', async () => {
    let fail = true;
    const source = createLiveSource({
      transport: {
        open: async () => {
          if (fail) throw Error('offline');
          return { read: async () => frame(100), close: async () => {} };
        },
      },
      accountId: 'a',
      deviceId: 'd',
      battery: true,
      now: () => 200,
    });
    expect(await source.poll()).toBeUndefined();
    fail = false;
    expect(await source.poll()).toBeDefined();
    await source.stop();
  });
  it('pins authenticated WHEP session URLs and refuses a credential-leaking redirect target', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('v=0\n', {
          status: 201,
          headers: { Location: 'https://evil.invalid/session' },
        }),
    );
    const signal = createWhepSignaling({
      token: () => 'mock-token',
      fetchFn: fetchFn as typeof fetch,
    });
    await expect(signal.open('d', 'v=0\n')).rejects.toThrow('session_location');
    expect(fetchFn.mock.calls).toHaveLength(1);
  });
});
