import { describe, expect, it } from 'vitest';
import {
  GLOBAL_TIMEOUT_MS,
  intruderPlan,
  newLadder,
  step,
  wildlifePlan,
  type ActuatorConfig,
  type FrameEval,
  type LadderState,
  type Mode,
} from '../src/ladder.ts';

const T0 = 1_000_000;
const person = (s: number): FrameEval => ({ kind: 'person', captureTs: T0 + s * 1000 });
const empty = (s: number): FrameEval => ({ kind: 'no_person', captureTs: T0 + s * 1000 });

// Feed frames in order; returns the final state and every level entered, with the frame second.
function run(frames: FrameEval[], mode: Mode = 'night', maxLevel = 4) {
  let s: LadderState = newLadder(T0);
  const entered: [number, number][] = [];
  let exit: string | undefined;
  for (const f of frames) {
    const now = 'captureTs' in f ? f.captureTs : (s.lastFrameMs ?? T0);
    const r = step(s, f, { now, mode, maxLevel });
    s = r.state;
    for (const l of r.enter) entered.push([l, 'captureTs' in f ? (f.captureTs - T0) / 1000 : -1]);
    if (r.exit) {
      exit = r.exit;
      break;
    }
  }
  return { s, entered, exit };
}

const every5s = (until: number) => Array.from({ length: until / 5 + 1 }, (_, i) => person(i * 5));

describe('intruder ladder: order and dwell timing', () => {
  it('a staged loiterer at night climbs L1 at 0 s, L2 at 10 s, L3 at 20 s, L4 at 40 s', () => {
    expect(run(every5s(65)).entered).toEqual([
      [1, 0],
      [2, 10],
      [3, 20],
      [4, 40],
    ]);
  });

  it('L4 needs mode away or night: in mode home the ladder stops at L3', () => {
    expect(run(every5s(90), 'home').s.level).toBe(3);
    expect(run(every5s(60), 'away').s.level).toBe(4);
  });

  it('the configured cap holds (follow-up frame gate open: cap 1)', () => {
    expect(run(every5s(90), 'night', 1).entered).toEqual([[1, 0]]);
  });

  it('a 12 s gap resets dwell but holds the level', () => {
    const { s, entered } = run([person(0), person(5), person(15), person(27), person(32)]);
    // 0..15 is continuous (dwell 15 s, L1); the 12 s gap restarts dwell at 27.
    expect(entered).toEqual([
      [1, 0],
      [2, 15],
    ]);
    expect(s.level).toBe(2);
    expect(s.dwellStartMs).toBe(T0 + 27_000);
  });

  it('a loiterer leaving at 5 s exits before L2; at 15 s reaches L2 and exits before L3', () => {
    const at15 = run([...every5s(5), empty(10), empty(15)]);
    expect(at15.entered).toEqual([[1, 0]]);
    expect(at15.exit).toBe('departure');
    const at30 = run([...every5s(15), empty(20), empty(25)]);
    expect(at30.entered).toEqual([
      [1, 0],
      [2, 10],
    ]);
    expect(at30.exit).toBe('departure');
  });

  it('one empty frame resets dwell without exiting; departure needs two in a row', () => {
    const r = run([person(0), person(5), empty(10), person(15)]);
    expect(r.exit).toBeUndefined();
    expect(r.s.dwellStartMs).toBe(T0 + 15_000);
  });

  it('bad evidence holds the level and three in a row exit', () => {
    const bad: FrameEval = { kind: 'bad', reason: 'stale' };
    const held = run([...every5s(15), bad, bad]);
    expect(held.s.level).toBe(2);
    expect(held.exit).toBeUndefined();
    expect(run([...every5s(15), bad, bad, bad]).exit).toBe('bad_evidence');
  });

  it('benign reclassification exits', () => {
    expect(run([person(0), { kind: 'benign', captureTs: T0 + 5000 }]).exit).toBe(
      'benign_reclassification',
    );
  });

  it('a late frame older than the last accepted one is ignored', () => {
    const { s, entered } = run([person(0), person(10), person(5)]);
    expect(s.lastFrameMs).toBe(T0 + 10_000);
    expect(entered).toEqual([
      [1, 0],
      [2, 10],
    ]);
  });

  it('global timeout exits after 5 min whatever the frames say', () => {
    const r = step(newLadder(T0), person(1), {
      now: T0 + GLOBAL_TIMEOUT_MS,
      mode: 'night',
      maxLevel: 4,
    });
    expect(r.exit).toBe('timeout');
  });
});

const cfg: ActuatorConfig = {
  interiorLights: ['light.stairs'],
  zones: {
    front_yard: {
      exteriorLight: 'switch.patio_light_socket_1',
      valve: 'valve.rf_water_timer_valve_1',
      durationSetter: 'number.rf_water_timer_irrigation_duration_1',
      speaker: 'pi_audio.porch_speaker',
    },
  },
  clips: { bark: 'bark-5s', wildlife: 'wildlife' },
  audioMode: 'bark',
};

describe('action plans', () => {
  it('L1 notifies and turns interior lights on with a 15 min revert; no audio', () => {
    const p = intruderPlan(1, 'front_yard', cfg);
    expect(p.steps[0].kind).toBe('notify');
    expect(p.steps[1]).toMatchObject({ entity_id: 'light.stairs', revertAfterMs: 900_000 });
    expect(p.steps.some((s) => s.kind === 'call' && s.service === 'play_clip')).toBe(false);
  });

  it('L3 plays the bark clip; L4 is a 30 s valve run', () => {
    expect(intruderPlan(3, 'front_yard', cfg).steps[0]).toMatchObject({
      service: 'play_clip',
      data: { clip: 'bark-5s' },
    });
    expect(intruderPlan(4, 'front_yard', cfg).steps[0]).toEqual({
      kind: 'valve_run',
      setter: 'number.rf_water_timer_irrigation_duration_1',
      valve: 'valve.rf_water_timer_valve_1',
      seconds: 30,
    });
  });

  it('wildlife: valve first, then lights (5 min), clip, notify', () => {
    const p = wildlifePlan('front_yard', 'armadillo', cfg);
    expect(p.steps.map((s) => (s.kind === 'call' ? s.service : s.kind))).toEqual([
      'valve_run',
      'turn_on',
      'play_clip',
      'notify',
    ]);
    expect(p.skipped).toEqual([]);
  });

  it('an unmapped zone or missing lights are reported as skipped, never guessed', () => {
    const p = wildlifePlan('back_yard', 'armadillo', { ...cfg, interiorLights: [] });
    expect(p.skipped).toEqual(['valve_run', 'interior_lights', 'speaker']);
    expect(p.steps.map((s) => s.kind)).toEqual(['notify']);
  });
});
