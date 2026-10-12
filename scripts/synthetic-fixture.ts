// Writes test/fixtures/synthetic-night.json: a HAND-BUILT night (not a real one) that exercises
// every ledger path: silent events, an intruder ladder from L1 to L4 that ends on an empty
// frame, and a wildlife run. Its label says so. A real night comes from scripts/export-fixture.ts.
// Usage: node scripts/synthetic-fixture.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { checkReplay, type Fixture, type FixtureEvent } from '../src/replay.ts';

const T0 = Date.parse('2026-10-08T23:00:00-05:00'); // inside the 20:00 to 06:30 night window
const DEVICE = 'cam-yard';

function webhook(id: string, ts: number, subType: string) {
  return {
    meta: { account_id: 'acct-synthetic', request_id: `req-${id}` },
    data: {
      id,
      type: 'motion_detected',
      attributes: { source: DEVICE, timestamp: ts, sub_type: subType },
    },
  };
}

function event(
  id: string,
  atMs: number,
  subType: string,
  perception: FixtureEvent['model']['perception'],
  critique?: FixtureEvent['model']['critique'],
): FixtureEvent {
  const ts = T0 + atMs;
  return {
    received_at: ts + 1000,
    webhook: webhook(id, ts, subType),
    frames: perception ? [{ ts_ring: ts }] : [],
    ready_after_event_ms: 2000,
    model: { perception, critique, perception_ms: 2400, critique_ms: 1200 },
  };
}

const person = (conf = 0.95) => ({
  subjects: [{ class: 'person', confidence: conf }],
  person_present: true,
  activity: 'standing at the side gate',
  night_ir: true,
});
const empty = { subjects: [], person_present: false, activity: 'nothing', night_ir: true };
const unknown = { verdict: 'unknown', reasons: ['person at night, not expected'] };

const events: FixtureEvent[] = [
  event('syn-01', 0, 'motion', empty),
  event('syn-02', 60_000, 'motion', {
    subjects: [{ class: 'cat', confidence: 0.9 }],
    person_present: false,
    activity: 'crossing the yard',
    night_ir: true,
  }),
  // The loiterer: a frame every 10 s, L1 at once, L2 at 20 s, L3 at 40 s, L4 at 60 s, then gone.
  ...[0, 10, 20, 30, 40, 50, 60].map((s, i) =>
    event(`syn-gate-${i}`, 120_000 + s * 1000, 'human', person(), unknown),
  ),
  event('syn-gate-gone-1', 190_000, 'human', empty),
  event('syn-gate-gone-2', 200_000, 'human', empty),
  event(
    'syn-03',
    1_200_000,
    'other_motion',
    {
      subjects: [{ class: 'armadillo', confidence: 0.96 }],
      person_present: false,
      activity: 'digging near the bed',
      night_ir: true,
    },
    { verdict: 'nuisance', reasons: ['configured nuisance species at night'] },
  ),
  event('syn-04', 1_500_000, 'motion', empty),
];

export function syntheticNight(): Fixture {
  return {
    version: 1,
    label: 'synthetic fixture, not a real night',
    synthetic: true,
    mode: 'away',
    config: {
      timezone: 'America/Chicago',
      nightWindow: { start: '20:00', end: '06:30' },
      zones: { [DEVICE]: 'front_yard' },
      context: {
        mode: 'away',
        knownPets: [],
        expectedVisitors: [],
        routines: [],
        nuisanceSpecies: ['armadillo'],
      },
      followUpProbe: false,
      coordinator: {
        allowlist: 'inline',
        publicBase: 'https://quiet-porch.example.invalid/ring',
        maxIntruderLevel: 4,
        cooldownMs: 600_000,
        ownerUserIds: ['mcp:owner'],
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
      },
    },
    allowlist: JSON.parse(
      readFileSync(new URL('../config/allowlist.json', import.meta.url), 'utf8'),
    ),
    events,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fx = syntheticNight();
  const { runs } = await checkReplay(fx, 1);
  fx.expected_ledger = runs[0];
  const out = new URL('../test/fixtures/synthetic-night.json', import.meta.url).pathname;
  writeFileSync(out, JSON.stringify(fx, null, 2) + '\n');
  execFileSync('npx', ['prettier', '--write', out], { stdio: 'ignore' }); // match the committed file
  console.log(`wrote ${out}`);
  console.log(runs[0].join('\n'));
}
