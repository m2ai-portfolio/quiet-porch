import { describe, expect, it, vi } from 'vitest';
import {
  createActuators,
  createDryRunActuators,
  createHaActuator,
  createPiAudioActuator,
  createTelegramNotifier,
  type Actuator,
  type Actuators,
} from '../src/actuators.ts';
import { loadAllowlist } from '../src/allowlist.ts';
import { createCoordinator, type Evaluation } from '../src/coordinator.ts';
import { openDb, recordIntent, openIncident } from '../src/db.ts';
import type { ActuatorConfig } from '../src/ladder.ts';

const allowlist = loadAllowlist(new URL('../config/allowlist.json', import.meta.url).pathname);
const withInterior = {
  entities: new Map(allowlist.entities).set('light.stairs', {
    entity_id: 'light.stairs',
    placement: 'interior',
    zones: [],
    services: { turn_on: {}, turn_off: {} },
  }),
};

const actuatorCfg: ActuatorConfig = {
  interiorLights: ['light.stairs'],
  zones: {
    front_yard: {
      exteriorLight: 'switch.patio_light_socket_1',
      valve: 'valve.front_yard_sprinkler_valve',
      durationSetter: 'number.front_yard_sprinkler_irrigation_duration',
      speaker: 'pi_audio.porch_speaker',
    },
  },
  clips: { bark: 'bark-5s', wildlife: 'wildlife' },
};

const T0 = 1_791_400_000_000;
const flush = () => new Promise<void>((r) => setImmediate(r));

function fakeClock(start = T0) {
  let t = start;
  const timers: { at: number; r: () => void }[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((r) => timers.push({ at: t + ms, r })),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.r();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

function setup(
  opts: {
    mode?: 'home' | 'away' | 'night';
    maxLevel?: number;
    wrap?: (a: Actuators) => Actuators;
    killed?: () => boolean;
  } = {},
) {
  const db = openDb(':memory:');
  const clock = fakeClock();
  const dry: object[] = [];
  const events: { event: string; [k: string]: unknown }[] = [];
  let actuators = createDryRunActuators((r) => dry.push(r), clock);
  if (opts.wrap) actuators = opts.wrap(actuators);
  const coord = createCoordinator(
    {
      actuators: actuatorCfg,
      mode: opts.mode ?? 'night',
      maxIntruderLevel: opts.maxLevel ?? 4,
      cooldownMs: 600_000,
      ownerUserIds: ['owner-matthew'],
      wildlifeMaxEvidenceAgeMs: 35_000,
    },
    {
      db,
      allowlist: withInterior,
      actuators,
      killed: opts.killed ?? (() => false),
      log: (r) => events.push(r),
      stopUrl: (i) => `https://example/ring/stop?i=${i}`,
      clock,
    },
  );
  const calls = () =>
    dry
      .filter((r) => (r as { kind: string }).kind === 'call')
      .map(
        (r) => `${(r as { service: string }).service} ${(r as { entity_id: string }).entity_id}`,
      );
  const notes = () => dry.filter((r) => (r as { kind: string }).kind === 'notify');
  const intents = () =>
    db.prepare('SELECT entity_id, service, cls, status FROM action_intents ORDER BY id').all() as {
      entity_id: string;
      service: string;
      cls: string;
      status: string;
    }[];
  const incidents = () =>
    db.prepare('SELECT id, profile, status, exit_reason, level FROM incidents ORDER BY id').all();
  let n = 0;
  // A decided event whose frame was captured `ageMs` ago.
  const ev = (kind: Evaluation['kind'], reason: string, extra: Partial<Evaluation> = {}) =>
    ({
      zone: 'front_yard',
      kind,
      reason,
      evidenceId: `ev_${++n}`,
      captureTs: clock.now(),
      ...extra,
    }) as Evaluation;
  const settle = async () => {
    await coord.idle();
    await flush();
    await coord.idle();
  };
  return { db, clock, coord, calls, notes, intents, incidents, events, ev, settle };
}

describe('coordinator: intruder ladder dispatch (dry run)', () => {
  it('an intruder decision opens one incident: L1 notify + interior lights, no audio, no valve', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    expect(t.calls()).toEqual(['turn_on light.stairs']);
    expect(t.notes()).toHaveLength(1);
    expect(t.intents().every((i) => i.status === 'dry_run')).toBe(true);
    expect(t.incidents()).toMatchObject([{ profile: 'intruder', status: 'active', level: 1 }]);
  });

  it('benign and uncertain decisions with no incident give zero intents and no notification', async () => {
    const t = setup();
    for (const r of ['benign', 'critique_uncertain', 'person_uncertain', 'nothing_actionable']) {
      await t.coord.onEvaluation(t.ev('log', r));
    }
    await t.settle();
    expect(t.intents()).toEqual([]);
    expect(t.notes()).toEqual([]);
    expect(t.incidents()).toEqual([]);
  });

  it('a staged loiterer at night reaches L4: duration set, read back, valve opened, closed on its own', async () => {
    const t = setup();
    for (let s = 0; s <= 60; s += 5) {
      await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
      await t.settle();
      await t.clock.advance(5000);
    }
    expect(t.calls()).toEqual([
      'turn_on light.stairs',
      'turn_on switch.patio_light_socket_1',
      'play_clip pi_audio.porch_speaker',
      'set_value number.front_yard_sprinkler_irrigation_duration',
      'open_valve valve.front_yard_sprinkler_valve',
    ]);
    await t.clock.advance(40_000);
    await t.coord.tick();
    expect(t.events.some((e) => e.event === 'valve_closed_on_its_own')).toBe(true);
  });

  it('the level cap holds: with max level 1 nothing past L1 is dispatched', async () => {
    const t = setup({ maxLevel: 1 });
    for (let s = 0; s <= 60; s += 5) {
      await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
      await t.settle();
      await t.clock.advance(5000);
    }
    expect(t.calls()).toEqual(['turn_on light.stairs']);
  });

  it('stale evidence never escalates: the frame is 16 s old at dispatch', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown', { captureTs: T0 - 16_000 }));
    await t.settle();
    expect(t.intents()).toEqual([]);
    expect(t.events.some((e) => e.reason === 'stale_evidence')).toBe(true);
  });

  it('kill switch: no incident opens and nothing is dispatched', async () => {
    const t = setup({ killed: () => true });
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', { species: 'armadillo' }));
    await t.settle();
    expect(t.incidents()).toEqual([]);
    expect(t.intents()).toEqual([]);
  });

  it('kill switch flipped mid-incident: later levels are refused, cleanup still runs', async () => {
    let killed = false;
    const t = setup({ killed: () => killed });
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    killed = true;
    for (let s = 5; s <= 25; s += 5) {
      await t.clock.advance(5000);
      await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
      await t.settle();
    }
    expect(t.calls()).toEqual(['turn_on light.stairs']);
    expect(t.events.some((e) => e.reason === 'kill_switch')).toBe(true);
    await t.coord.standDown(1, 'owner');
    expect(t.calls().at(-1)).toBe('turn_off light.stairs');
  });

  it('concurrent events create one incident', async () => {
    const t = setup();
    await Promise.all([
      t.coord.onEvaluation(t.ev('intruder', 'person_unknown')),
      t.coord.onEvaluation(t.ev('intruder', 'person_suspicious')),
    ]);
    await t.settle();
    expect(t.incidents()).toHaveLength(1);
  });

  it('a person in another zone is logged and notified once, never inherited', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    for (let i = 0; i < 2; i++) {
      await t.coord.onEvaluation(t.ev('intruder', 'person_unknown', { zone: 'back_yard' }));
    }
    await t.settle();
    expect(t.incidents()).toHaveLength(1);
    expect(t.notes()).toHaveLength(2); // L1 + one cross-zone note
  });
});

describe('coordinator: stand-down, cleanup, reconcile', () => {
  it('stand-down cancels, drops queued escalations, turns touched entities off, sets cooldown', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    expect(await t.coord.standDown(1, 'stop_link')).toBe('stopped');
    expect(t.calls()).toEqual(['turn_on light.stairs', 'turn_off light.stairs']);
    expect(t.incidents()).toMatchObject([
      { status: 'cancelled', exit_reason: 'stand_down:stop_link' },
    ]);
    // A late intruder result for the same zone cannot reopen it during the cooldown.
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    expect(t.incidents()).toHaveLength(1);
    expect(await t.coord.standDown(1, 'again')).toBe('not_active');
  });

  it('a call that never returns: unknown intent, null-context reconcile row, entity inhibited', async () => {
    const hang: Actuator = { call: () => new Promise(() => {}), readState: async () => 'off' };
    const t = setup({ wrap: (a) => ({ ...a, ha: hang }) });
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await flush();
    await t.clock.advance(3000);
    await t.settle();
    expect(t.intents()).toMatchObject([{ entity_id: 'light.stairs', status: 'unknown' }]);
    const row = t.db.prepare('SELECT entity_id, ha_context_id, reason FROM reconcile').get();
    expect(row).toEqual({ entity_id: 'light.stairs', ha_context_id: null, reason: 'call_timeout' });
  });

  it('stand-down while a call hangs: cleanup starts within 4 s', async () => {
    let release!: () => void;
    const slow: Actuator = {
      call: ({ service }) =>
        service === 'turn_on'
          ? new Promise((r) => (release = () => r({ ok: true })))
          : Promise.resolve({ ok: true }),
      readState: async () => 'off',
    };
    const t = setup({ wrap: (a) => ({ ...a, ha: slow }) });
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await flush();
    const stopped = t.coord.standDown(1, 'owner');
    await t.clock.advance(4000);
    await stopped;
    const off = t.db
      .prepare("SELECT dispatched_at FROM action_intents WHERE service = 'turn_off'")
      .get() as { dispatched_at: number };
    expect(off.dispatched_at - T0).toBeLessThanOrEqual(4000);
    release();
  });

  it('a null-context reconcile row stays open while reading back off; only an owner clears it', async () => {
    const t = setup();
    t.db
      .prepare(
        "INSERT INTO reconcile (entity_id, action, reason, created_at, next_check_ms) VALUES ('switch.patio_light_socket_1', 'turn_on', 'call_timeout', ?, ?)",
      )
      .run(T0, T0);
    for (let i = 0; i < 5; i++) {
      await t.coord.tick();
      await t.clock.advance(10 * 60_000);
    }
    const open = () =>
      t.db.prepare('SELECT COUNT(*) AS n FROM reconcile WHERE resolved_at IS NULL').get();
    expect(open()).toEqual({ n: 1 });
    expect(t.coord.clearReconcile(1, 'quiet-porch')).toBe(false);
    expect(t.coord.clearReconcile(1, 'owner-matthew')).toBe(true);
    expect(open()).toEqual({ n: 0 });
  });

  it('an entity with an open reconcile row cannot be escalated, but safety still runs', async () => {
    const t = setup();
    t.db
      .prepare(
        "INSERT INTO reconcile (entity_id, action, reason, created_at, next_check_ms) VALUES ('light.stairs', 'turn_on', 'x', ?, ?)",
      )
      .run(T0, T0 + 999_999);
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    expect(t.calls()).toEqual([]);
    expect(t.events.some((e) => e.reason === 'reconcile_inhibited')).toBe(true);
    await t.coord.standDown(1, 'owner');
    expect(t.calls()).toEqual([]); // nothing was touched, so nothing to clean
  });

  it('boot: pending intents become reconcile rows, the open incident closes, exterior swept off', async () => {
    const t = setup();
    const id = openIncident(t.db, 'front_yard', 'intruder', T0)!;
    recordIntent(t.db, {
      intentId: 'i-crash',
      incidentId: id,
      entityId: 'switch.patio_light_socket_1',
      service: 'turn_on',
      cls: 'escalation',
    });
    expect(await t.coord.boot()).toEqual({ converted: 1, closed: 1 });
    expect(t.incidents()).toMatchObject([{ status: 'exited', exit_reason: 'restart' }]);
    expect(t.calls().sort()).toEqual([
      'close_valve valve.front_yard_sprinkler_valve',
      'stop pi_audio.porch_speaker',
      'turn_off switch.patio_light_socket_1',
    ]);
    expect(
      t
        .intents()
        .filter((i) => i.cls === 'escalation')
        .map((i) => i.status),
    ).toEqual(['unknown']);
  });
});

describe('coordinator: wildlife profile', () => {
  const armadillo = { species: 'armadillo' };

  it('runs valve (30 s, read back), lights, clip, notify; completes at +40 s; cooldown holds', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
    await t.settle();
    expect(t.calls()).toEqual([
      'set_value number.front_yard_sprinkler_irrigation_duration',
      'open_valve valve.front_yard_sprinkler_valve',
      'turn_on light.stairs',
      'play_clip pi_audio.porch_speaker',
    ]);
    expect(t.notes()).toHaveLength(1);
    await t.clock.advance(40_000);
    await t.coord.tick();
    expect(t.events.some((e) => e.event === 'valve_closed_on_its_own')).toBe(true);
    expect(t.incidents()).toMatchObject([{ profile: 'wildlife', exit_reason: 'completed' }]);
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
    await t.settle();
    expect(t.incidents()).toHaveLength(1);
    // Lights revert after 5 min, not at completion.
    await t.clock.advance(5 * 60_000);
    await t.coord.tick();
    expect(t.calls().at(-1)).toBe('turn_off light.stairs');
  });

  it('a wildlife trigger frame up to 35 s old runs the whole plan; 36 s is not opened', async () => {
    const t = setup();
    await t.coord.onEvaluation(
      t.ev('wildlife', 'nuisance_at_night', { ...armadillo, captureTs: T0 - 32_000 }),
    );
    await t.settle();
    expect(t.calls()).toEqual([
      'set_value number.front_yard_sprinkler_irrigation_duration',
      'open_valve valve.front_yard_sprinkler_valve',
      'turn_on light.stairs',
      'play_clip pi_audio.porch_speaker',
    ]);
    const u = setup();
    await u.coord.onEvaluation(
      u.ev('wildlife', 'nuisance_at_night', { ...armadillo, captureTs: T0 - 36_000 }),
    );
    await u.settle();
    expect(u.calls()).toEqual([]);
    expect(u.incidents()).toEqual([]);
  });

  it('the longer wildlife window never applies to the intruder ladder', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown', { captureTs: T0 - 20_000 }));
    await t.settle();
    expect(t.intents()).toEqual([]);
  });

  it('a duration read-back mismatch blocks open_valve', async () => {
    const t = setup({
      wrap: (a) => ({
        ...a,
        ha: {
          call: a.ha.call,
          readState: async (e) => (e.startsWith('number.') ? '20' : a.ha.readState(e)),
        },
      }),
    });
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
    await t.settle();
    expect(t.calls()).not.toContain('open_valve valve.front_yard_sprinkler_valve');
    expect(t.events.some((e) => e.reason === 'duration_read_back_mismatch')).toBe(true);
  });

  it('a valve still open at +40 s opens a reconcile row and alerts', async () => {
    const t = setup({
      wrap: (a) => ({
        ...a,
        ha: {
          call: a.ha.call,
          readState: async (e) => (e.startsWith('valve.') ? 'open' : a.ha.readState(e)),
        },
      }),
    });
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
    await t.settle();
    await t.clock.advance(40_000);
    await t.coord.tick();
    expect(t.db.prepare('SELECT entity_id, reason FROM reconcile').all()).toContainEqual({
      entity_id: 'valve.front_yard_sprinkler_valve',
      reason: 'valve_open_after_40s',
    });
  });

  it('a same-zone person during watering preempts atomically: wildlife cancelled, valve closed, L1', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
    await t.settle();
    await t.clock.advance(5000);
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    expect(t.incidents()).toMatchObject([
      { profile: 'wildlife', status: 'cancelled', exit_reason: 'preempted' },
      { profile: 'intruder', status: 'active', level: 1 },
    ]);
    const after = t.calls().slice(4);
    expect(after).toContain('close_valve valve.front_yard_sprinkler_valve');
    expect(after).toContain('stop pi_audio.porch_speaker');
    expect(after.at(-1)).toBe('turn_on light.stairs');
  });

  it('wildlife during an open intruder incident is logged only', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
    await t.settle();
    expect(t.calls()).toEqual(['turn_on light.stairs']);
    expect(t.events.some((e) => e.event === 'wildlife_during_intruder')).toBe(true);
  });

  it('a wildlife cooldown never blocks an intruder', async () => {
    const t = setup();
    await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
    await t.settle();
    await t.clock.advance(40_000);
    await t.coord.tick();
    await t.coord.onEvaluation(t.ev('intruder', 'person_unknown'));
    await t.settle();
    expect(t.incidents()).toMatchObject([
      { profile: 'wildlife' },
      { profile: 'intruder', status: 'active' },
    ]);
  });

  it('the audio rate cap allows at most 3 clips in 60 s', async () => {
    const t = setup();
    const plays = () => t.calls().filter((c) => c.startsWith('play_clip')).length;
    for (let i = 0; i < 4; i++) {
      await t.coord.onEvaluation(t.ev('wildlife', 'nuisance_at_night', armadillo));
      await t.settle();
      await t.clock.advance(40_000);
      await t.coord.tick();
      t.db.exec('DELETE FROM cooldowns');
      await t.clock.advance(-30_000); // keep the four runs inside one minute of clock time
    }
    expect(plays()).toBe(3);
    expect(t.events.some((e) => e.reason === 'audio_rate_cap')).toBe(true);
  });
});

describe('actuators: the dry-run lock and live adapters', () => {
  it('dry run builds simulators only: no fetch, no ssh', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const a = createActuators(true, () => {});
    expect(a.live).toBe(false);
    await a.ha.call({
      intentId: 'x',
      entity_id: 'valve.front_yard_sprinkler_valve',
      service: 'open_valve',
      dispatchEpochMs: 1,
    });
    await a.notifier.send({ incidentId: 1, text: 'hi' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('live settings are required to leave dry run', () => {
    expect(() => createActuators(false, () => {})).toThrow(/without live settings/);
  });

  it('HA REST: posts the service and takes the context only from our entity', async () => {
    const fetchFn = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () =>
        Response.json([
          { entity_id: 'light.other', context: { id: 'ctx-other' } },
          { entity_id: 'light.stairs', context: { id: 'ctx-ours' } },
        ]),
    );
    const ha = createHaActuator({ baseUrl: 'http://ha', token: 't', fetchFn });
    const r = await ha.call({
      intentId: 'i',
      entity_id: 'light.stairs',
      service: 'turn_on',
      dispatchEpochMs: 1,
    });
    expect(r).toEqual({ ok: true, contextId: 'ctx-ours' });
    expect(fetchFn.mock.calls[0][0]).toBe('http://ha/api/services/light/turn_on');
    const none = createHaActuator({
      baseUrl: 'http://ha',
      token: 't',
      fetchFn: async () => Response.json([]),
    });
    expect(
      await none.call({
        intentId: 'i',
        entity_id: 'light.stairs',
        service: 'turn_on',
        dispatchEpochMs: 1,
      }),
    ).toEqual({ ok: true, contextId: undefined });
  });

  it('pi_audio: qp-play gets intent id, dispatch epoch and the pinned clip; odd clips refused', async () => {
    const exec = vi.fn<(cmd: string, args: string[], ms: number) => Promise<string>>(
      async () => 'started qp-audio-abc\n',
    );
    const pi = createPiAudioActuator({ host: 'rpi-claw', exec });
    const ok = await pi.call({
      intentId: 'abc-123',
      entity_id: 'pi_audio.porch_speaker',
      service: 'play_clip',
      data: { clip: 'bark-5s' },
      dispatchEpochMs: 42,
    });
    expect(ok).toEqual({ ok: true });
    expect(exec.mock.calls[0]![1].slice(-4)).toEqual(['qp-play', 'abc-123', '42', 'bark-5s']);
    const bad = await pi.call({
      intentId: 'abc',
      entity_id: 'pi_audio.porch_speaker',
      service: 'play_clip',
      data: { clip: 'x; rm -rf ~' },
      dispatchEpochMs: 1,
    });
    expect(bad).toEqual({ ok: false, error: 'bad_argument' });
  });

  it('Telegram: sendPhoto with the frame and a Stop URL button', async () => {
    const fetchFn = vi.fn(async () => new Response('{}'));
    const tg = createTelegramNotifier({ token: 'T', chatId: '-100', fetchFn });
    await tg.send({
      incidentId: 1,
      text: 'armadillo',
      frame: Buffer.from([1, 2]),
      stopUrl: 'https://s',
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { body: FormData }];
    expect(url).toMatch(/sendPhoto$/);
    expect(JSON.parse(String(init.body.get('reply_markup')))).toEqual({
      inline_keyboard: [[{ text: 'Stop', url: 'https://s' }]],
    });
  });
});
