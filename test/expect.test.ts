import { describe, expect, it } from 'vitest';
import { createDryRunActuators } from '../src/actuators.ts';
import { loadAllowlist } from '../src/allowlist.ts';
import { createCoordinator, type Evaluation } from '../src/coordinator.ts';
import { activeIncident, EXPECT_MAX_MINUTES, openDb } from '../src/db.ts';
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
