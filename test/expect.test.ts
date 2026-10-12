import { describe, expect, it } from 'vitest';
import { createDryRunActuators } from '../src/actuators.ts';
import { loadAllowlist } from '../src/allowlist.ts';
import { createCoordinator, type Evaluation } from '../src/coordinator.ts';
import { activeIncident, EXPECT_GRACE_MS, EXPECT_MAX_MINUTES, openDb } from '../src/db.ts';
import type { ActuatorConfig } from '../src/ladder.ts';
import { fakeClock } from './helpers/fake-clock.ts';

const allowlist = loadAllowlist(new URL('../config/allowlist.json', import.meta.url).pathname);
const actuatorCfg: ActuatorConfig = {
  interiorLights: ['light.worklights'],
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

function setup() {
  const db = openDb(':memory:');
  const clock = fakeClock(T0);
  const coord = createCoordinator(
    {
      actuators: actuatorCfg,
      mode: 'away',
      maxIntruderLevel: 4,
      cooldownMs: 600_000,
      ownerUserIds: ['mcp:owner'],
      wildlifeMaxEvidenceAgeMs: 35_000,
    },
    {
      db,
      allowlist,
      actuators: createDryRunActuators(() => {}, clock),
      killed: () => false,
      log: () => {},
      stopUrl: (id) => `https://x.invalid/stop?i=${id}`,
      clock,
    },
  );
  let n = 0;
  const person = (): Evaluation => {
    n++;
    return {
      sourceEventId: `e${n}`,
      zone: 'front_yard',
      kind: 'intruder',
      reason: 'person_unknown',
      evidenceId: `ev${n}`,
      captureTs: clock.now() - 1000,
    };
  };
  const outcomes = () =>
    db
      .prepare(
        'SELECT source_event_id AS id, outcome, level_after AS level, incident_id AS inc, note FROM event_outcomes ORDER BY applied_at, rowid',
      )
      .all();
  const intents = () =>
    db.prepare('SELECT COUNT(*) AS n FROM action_intents').get() as { n: number };
  return { db, clock, coord, person, outcomes, intents };
}

const wildlife = (s: ReturnType<typeof setup>): Evaluation => ({
  sourceEventId: 'w1',
  zone: 'front_yard',
  kind: 'wildlife',
  reason: 'nuisance_at_night',
  species: 'armadillo',
  evidenceId: 'evw',
  captureTs: s.clock.now() - 1000,
});

describe('expect_me, "I\'m stepping out"', () => {
  it('without a window a person opens the ladder, and the outcome records the level', async () => {
    const s = setup();
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(activeIncident(s.db)?.level).toBe(1);
    expect(s.outcomes()).toMatchObject([{ id: 'e1', outcome: 'incident', level: 1 }]);
  });

  it('inside the window a person closes at L0 as "expected": no incident, no action', async () => {
    const s = setup();
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(activeIncident(s.db)).toBeUndefined();
    expect(s.intents().n).toBe(0);
    expect(s.outcomes()).toMatchObject([
      { id: 'e1', outcome: 'expected', level: 0, inc: null, note: 'Lutfiya' },
    ]);
  });

  it('the window is bounded: after it ends the ladder opens again', async () => {
    const s = setup();
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    await s.clock.advance(10 * 60_000 + 1000);
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(activeIncident(s.db)?.level).toBe(1);
    expect(s.outcomes()).toMatchObject([{ outcome: 'incident' }]);
  });

  it('is clamped to the maximum, and a missing length means ten minutes', async () => {
    const s = setup();
    const long = s.coord.expectMe('x', 5000, 'mcp:owner');
    expect(long.expires_at - long.created_at).toBe(EXPECT_MAX_MINUTES * 60_000);
    const dflt = s.coord.expectMe('x', undefined, 'mcp:owner');
    expect(dflt.expires_at - dflt.created_at).toBe(10 * 60_000);
  });

  it('saying it while a ladder runs ends that incident and turns things off', async () => {
    const s = setup();
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(activeIncident(s.db)).toBeDefined();
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    await s.clock.advance(2000); // the next frame is captured after the owner spoke
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(activeIncident(s.db)).toBeUndefined();
    const closed = s.db.prepare('SELECT status, exit_reason FROM incidents').get();
    expect(closed).toEqual({ status: 'cancelled', exit_reason: 'expected:Lutfiya' });
    const off = s.db
      .prepare("SELECT COUNT(*) AS n FROM action_intents WHERE service = 'turn_off'")
      .get() as { n: number };
    expect(off.n).toBeGreaterThan(0);
  });

  it('does not touch the wildlife profile', async () => {
    const s = setup();
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    await s.coord.onEvaluation({
      sourceEventId: 'w1',
      zone: 'front_yard',
      kind: 'wildlife',
      reason: 'nuisance_at_night',
      species: 'armadillo',
      evidenceId: 'evw',
      captureTs: s.clock.now() - 1000,
    });
    await s.coord.idle();
    expect(activeIncident(s.db)?.profile).toBe('wildlife');
  });

  it('a cooldown refusal is a recorded outcome, not a silent gap', async () => {
    const s = setup();
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    await s.coord.standDown(activeIncident(s.db)!.id, 'test');
    await s.coord.onEvaluation(s.person());
    expect(s.outcomes().at(-1)).toMatchObject({ outcome: 'not_opened', note: 'intruder_cooldown' });
  });
});

describe('expect_me corner cases found in review', () => {
  it('a person during a wildlife run inside the window still stops the sprinkler, and starts no ladder', async () => {
    const s = setup();
    await s.coord.onEvaluation(wildlife(s));
    await s.coord.idle();
    const valve = () =>
      s.db
        .prepare("SELECT service FROM action_intents WHERE entity_id LIKE 'valve.%' ORDER BY id")
        .all()
        .map((r) => (r as { service: string }).service);
    expect(valve()).toContain('open_valve');
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(valve()).toContain('close_valve');
    expect(activeIncident(s.db)).toBeUndefined();
    expect(s.db.prepare('SELECT status, exit_reason FROM incidents').get()).toEqual({
      status: 'cancelled',
      exit_reason: 'expected:Lutfiya',
    });
  });

  it('an expected end sets no cooldown, so a real person after the window is not ignored', async () => {
    const s = setup();
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    s.coord.expectMe('A', 1, 'mcp:owner');
    await s.clock.advance(2000);
    await s.coord.onEvaluation(s.person()); // ends the running incident as expected
    await s.coord.idle();
    expect(activeIncident(s.db)).toBeUndefined();
    await s.clock.advance(61_000);
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(activeIncident(s.db)?.level).toBe(1);
    expect(s.outcomes().at(-1)).toMatchObject({ outcome: 'incident' });
  });

  it('is judged on the frame capture time, not on when it was evaluated', async () => {
    const s = setup();
    const stale: Evaluation = { ...s.person(), captureTs: s.clock.now() - 3_600_000 };
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    await s.coord.onEvaluation(stale);
    await s.coord.idle();
    expect(s.outcomes()[0]).toMatchObject({ outcome: 'incident' }); // not "expected"
    const s2 = setup();
    s2.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    const justBefore: Evaluation = {
      ...s2.person(),
      captureTs: s2.clock.now() - EXPECT_GRACE_MS + 1000,
    };
    await s2.coord.onEvaluation(justBefore);
    expect(s2.outcomes()[0]).toMatchObject({ outcome: 'expected' });
  });

  it('cancelExpectation ends the window now', async () => {
    const s = setup();
    s.coord.expectMe('Lutfiya', 60, 'mcp:owner');
    expect(s.coord.cancelExpectation('mcp:owner')).toBe(1);
    expect(s.coord.cancelExpectation('mcp:owner')).toBe(0);
    await s.clock.advance(1000);
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    expect(activeIncident(s.db)?.level).toBe(1);
  });

  it('chained windows are the owner explicitly asking again; the newest one wins until cancelled', async () => {
    const s = setup();
    s.coord.expectMe('A', 60, 'mcp:owner');
    s.coord.expectMe('B', 1, 'mcp:owner');
    expect(s.coord.cancelExpectation('mcp:owner')).toBe(2); // one call ends them all
  });

  it('after an expected end of a wildlife run, a second wildlife frame does not re-open the sprinkler (round 2)', async () => {
    const s = setup();
    await s.coord.onEvaluation(wildlife(s));
    await s.coord.idle();
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    await s.coord.onEvaluation(s.person());
    await s.coord.idle();
    await s.clock.advance(2000);
    await s.coord.onEvaluation({ ...wildlife(s), sourceEventId: 'w2', evidenceId: 'evw2' });
    await s.coord.idle();
    expect(activeIncident(s.db)).toBeUndefined();
    expect(s.outcomes().at(-1)).toMatchObject({ outcome: 'not_opened', note: 'wildlife_cooldown' });
  });

  it('the pre-window grace never ends a ladder that was already running (round 2)', async () => {
    const s = setup();
    await s.coord.onEvaluation(s.person()); // the ladder opens at L1
    await s.coord.idle();
    await s.clock.advance(5000);
    s.coord.expectMe('Lutfiya', 10, 'mcp:owner');
    // a frame captured 4 s BEFORE the window opened: inside the 10 s grace, but a ladder runs
    await s.coord.onEvaluation({ ...s.person(), captureTs: s.clock.now() - 4000 });
    await s.coord.idle();
    expect(activeIncident(s.db)).toBeDefined();
    expect(s.outcomes().at(-1)).toMatchObject({ outcome: 'incident' });
  });
});
