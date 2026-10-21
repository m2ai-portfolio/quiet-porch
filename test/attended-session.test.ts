import { expect, it, vi } from 'vitest';
import { runAttendedSession, type SlotContext, type SlotResult } from '../src/attended-session.ts';
import { sessionSlotMs } from '../src/attended-session-policy.ts';
import { runBoundedYard, type YardRunDependencies } from '../src/bounded-yard.ts';
import type { ContentBlock } from '../src/bedrock.ts';
import type { MotionWake } from '../src/attended-source.ts';
import type { PipelineConfig } from '../src/pipeline.ts';

const scope = { accountId: 'fixture-owner', deviceId: 'fixture-camera', zone: 'front_yard' };
const minute = 60000;

function slotResult(change: Partial<SlotResult> = {}): SlotResult {
  return {
    event: 'attended_delivery_finished',
    mode: 'attended_delivery',
    reason: 'no_encounter',
    safety_pass: true,
    observation_result: 'not_evaluated',
    transport_result: 'inconclusive',
    physical_delivery: 'owner_confirmation_required',
    speaker_readiness: 'checked_on_admission',
    frames: 0,
    model_calls: 0,
    observations: 0,
    stale_results: 0,
    max_dwell_ms: 0,
    model_unavailable_recovery: 'enabled',
    stale_result_recovery: 'enabled',
    recovery_attempts: 0,
    recovery_cause: undefined,
    dwell_resets: 0,
    alert_attempts: 0,
    speech_attempts: 0,
    alert_acknowledgements: 0,
    speech_acknowledgements: 0,
    speech_remaining_ms: undefined,
    cleanup_succeeded: true,
    outstanding_requests: 0,
    drained: true,
    elapsed_ms: 300000,
    ...change,
  } as SlotResult;
}
const encounter = (change: Partial<SlotResult> = {}) =>
  slotResult({ reason: 'encounter_completed', frames: 20, model_calls: 40, ...change });

// A scripted session: each slot consumes virtual time and returns the next scripted result.
function rig(script: ((ctx: SlotContext) => SlotResult)[], startDelay = 0) {
  const t0 = Date.UTC(2026, 9, 22, 16, 0);
  let time = t0,
    cooldown = 0,
    killed = false,
    authorized = true;
  const rows: Record<string, unknown>[] = [];
  const pendingWakes: MotionWake[] = [];
  const starts: number[] = [];
  const contexts: SlotContext[] = [];
  const deps: Parameters<typeof runAttendedSession>[0] = {
    startsAt: t0 + startDelay,
    expiresAt: t0 + startDelay + 60 * minute,
    maxEncounters: 3,
    totals: { frames: 90, modelCalls: 180 },
    cursor: 0,
    readWakes: (cursor) => ({ after: cursor + pendingWakes.length, wakes: pendingWakes.splice(0) }),
    cooldownUntil: () => cooldown,
    authorized: () => authorized,
    killed: () => killed,
    runSlot: vi.fn(async (ctx: SlotContext) => {
      starts.push(time);
      contexts.push(ctx);
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      const result = next(ctx);
      time += result.reason === 'encounter_completed' ? 2 * minute : 5 * minute;
      if (result.reason === 'encounter_completed') cooldown = time + 10 * minute; // like reserve()
      return result;
    }),
    audit: (row) => rows.push(row),
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  return {
    deps,
    rows,
    starts,
    contexts,
    t0,
    wake: (eventTs: number, id = `w${eventTs}`) =>
      pendingWakes.push({ ...scope, id, eventTs, source: 'ring_event' }),
    kill: () => {
      killed = true;
    },
    revoke: () => {
      authorized = false;
    },
    advance: (ms: number) => {
      time += ms;
    },
    time: () => time,
  };
}
const events = (rows: Record<string, unknown>[], event: string) =>
  rows.filter((row) => row.event === event);

it('waits disarmed until the agreed start, logging a heartbeat each minute and no slot', async () => {
  const r = rig([], 10 * minute);
  r.deps.expiresAt = r.deps.startsAt + sessionSlotMs - 1; // cannot fit a slot after start
  const result = await runAttendedSession(r.deps);
  expect(r.deps.runSlot).not.toHaveBeenCalled();
  expect(result).toMatchObject({ reason: 'session_expired', slots: 0, encounters: 0 });
  const waiting = events(r.rows, 'session_waiting');
  expect(waiting.length).toBe(10);
  expect(waiting.every((row) => row.phase === 'before_start')).toBe(true);
});

it('quiet slots never consume an encounter; the last slot starts only if it can finish', async () => {
  const r = rig(Array.from({ length: 20 }, () => () => slotResult()));
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({
    reason: 'session_expired',
    encounters: 0,
    frames: 0,
    safety_pass: true,
    transport_result: 'inconclusive',
  });
  expect(r.starts.length).toBe(result.slots);
  expect(r.starts.length).toBeGreaterThan(10);
  for (const start of r.starts) expect(start + sessionSlotMs).toBeLessThanOrEqual(r.deps.expiresAt);
  // A quiet session's longest gap covers the whole active session.
  expect(result.longest_quiet_ms).toBeGreaterThanOrEqual(55 * minute);
});

it('after an encounter it waits out the shared cooldown and re-arms only on newer wakes', async () => {
  const r = rig([
    () => encounter(),
    (ctx) => {
      // A wake stamped before re-arm is logged but never admitted.
      r.wake(r.time() - 13 * minute, 'old');
      r.wake(r.time() - 1000, 'new');
      const admitted = ctx.readWakes(0).wakes.map((w) => w.id);
      expect(admitted).toEqual(['new']);
      return encounter();
    },
    () => encounter(),
  ]);
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ reason: 'encounters_exhausted', encounters: 3, slots: 3 });
  // Encounter 1 ended at +2 min with cooldown to +12 min; slot 2 starts no earlier.
  expect(r.starts[1] - r.t0).toBeGreaterThanOrEqual(12 * minute);
  expect(r.starts[2] - r.starts[1]).toBeGreaterThanOrEqual(12 * minute);
  expect(r.contexts.map((c) => c.encounter)).toEqual([1, 2, 3]);
  expect(events(r.rows, 'session_waiting').some((row) => row.phase === 'cooldown')).toBe(true);
  const seen = events(r.rows, 'session_wake_seen');
  expect(seen.map((row) => [row.event_id, row.eligible])).toEqual([
    ['old', false],
    ['new', true],
  ]);
  expect(result.wakes_seen).toBe(2);
});

it('the first output attempt ends the session even with encounters left', async () => {
  const r = rig([
    () => encounter(),
    () =>
      encounter({
        alert_attempts: 1,
        speech_attempts: 1,
        alert_acknowledgements: 1,
        speech_acknowledgements: 1,
        transport_result: 'acknowledged',
      }),
    () => encounter(),
  ]);
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({
    reason: 'output_attempted',
    encounters: 2,
    slots: 2,
    alert_attempts: 1,
    speech_attempts: 1,
    transport_result: 'acknowledged',
    safety_pass: true,
  });
  expect(r.deps.runSlot).toHaveBeenCalledTimes(2);
});

it('an alert attempt without speech still ends the session; nothing is retried', async () => {
  const r = rig([() => encounter({ alert_attempts: 1 }), () => encounter()]);
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ reason: 'output_attempted', slots: 1 });
});

it('session totals are enforced across slots and an overspend fails safety', async () => {
  const r = rig([
    (ctx) => {
      for (let i = 0; i < 30; i++) ctx.spendFrame();
      return encounter({ frames: 30 });
    },
    (ctx) => {
      for (let i = 0; i < 30; i++) ctx.spendFrame();
      return encounter({ frames: 30 });
    },
    (ctx) => {
      for (let i = 0; i < 30; i++) ctx.spendFrame();
      expect(() => ctx.spendFrame()).toThrow('session_frames_cap');
      return encounter({ frames: 31 });
    },
  ]);
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ safety_pass: false, frames: 91, transport_result: 'fail' });
});

it('a cap error swallowed by the slot still fails session safety', async () => {
  const r = rig([
    (ctx) => {
      for (let i = 0; i < 181; i++)
        try {
          ctx.spendModelCall();
        } catch {
          // a runner that ignores the cap must not hide the overspend
        }
      return encounter({ model_calls: 60 });
    },
  ]);
  r.deps.maxEncounters = 1;
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ reason: 'encounters_exhausted', safety_pass: false });
  expect(result.transport_result).toBe('fail');
});

it('reaching the model-call total stops before another slot', async () => {
  const r = rig([
    (ctx) => {
      for (let i = 0; i < 180; i++) ctx.spendModelCall();
      return encounter({ model_calls: 60 });
    },
    () => encounter(),
  ]);
  r.deps.maxEncounters = 3;
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ reason: 'totals_reached', slots: 1 });
});

it.each([
  ['fault reason', slotResult({ reason: 'qualification_fault', safety_pass: false })],
  ['unsafe encounter', encounter({ safety_pass: false })],
  ['undrained', encounter({ drained: false })],
  ['cleanup unconfirmed', encounter({ cleanup_succeeded: false })],
  ['failed transport', encounter({ transport_result: 'fail' })],
  ['undrained quiet slot', slotResult({ drained: false })],
  ['cancelled slot', slotResult({ reason: 'qualification_cancelled' })],
])('a %s stops the session as a fault with no further slot', async (_name, bad) => {
  const r = rig([() => bad, () => encounter()]);
  const result = await runAttendedSession(r.deps);
  expect(result.reason).toBe('slot_fault');
  expect(result.transport_result).toBe('fail');
  expect(r.deps.runSlot).toHaveBeenCalledTimes(1);
});

it('KILL while waiting for the start ends the session without any slot', async () => {
  const r = rig([], 5 * minute);
  r.deps.sleep = async (ms) => {
    r.advance(ms);
    if (r.time() - r.t0 >= 2 * minute) r.kill();
  };
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ reason: 'killed', slots: 0 });
});

it('KILL during cooldown ends the session before the next slot', async () => {
  const r = rig([() => encounter(), () => encounter()]);
  r.deps.sleep = async (ms) => {
    r.advance(ms);
    r.kill();
  };
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ reason: 'killed', slots: 1, encounters: 1 });
});

it('authority lost at a slot boundary ends the session; cancellation does too', async () => {
  const lost = rig([() => encounter(), () => encounter()]);
  lost.deps.sleep = async (ms) => {
    lost.advance(ms);
    lost.revoke();
  };
  expect(await runAttendedSession(lost.deps)).toMatchObject({ reason: 'authority_lost', slots: 1 });
  const cancelled = rig([() => slotResult()]);
  const abort = new AbortController();
  abort.abort();
  cancelled.deps.signal = abort.signal;
  expect(await runAttendedSession(cancelled.deps)).toMatchObject({
    reason: 'session_cancelled',
    slots: 0,
  });
});

it('a throwing slot runner is a session fault, never a silent continue', async () => {
  const r = rig([]);
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({ reason: 'session_fault', transport_result: 'fail' });
  expect(events(r.rows, 'session_fault')).toHaveLength(1);
});

// The real one-encounter engine inside a session: shared cooldown, re-arm and one output.
function engineRig() {
  const t0 = Date.UTC(2026, 9, 22, 3, 0);
  let time = t0,
    cooldown = 0,
    person = false;
  const cfg: PipelineConfig = {
    dryRun: true,
    zones: { [scope.deviceId]: scope.zone },
    timezone: 'UTC',
    nightWindow: { start: '20:00', end: '06:30' },
    followUpProbe: false,
    wildlifeMaxEvidenceAgeMs: 35000,
    context: {
      mode: 'night',
      knownPets: [],
      expectedVisitors: [],
      routines: [],
      nuisanceSpecies: [],
    },
  };
  const rows: Record<string, unknown>[] = [];
  const wakeAt = new Set<number>();
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const converse = vi.fn(async (content: ContentBlock[]) => {
    const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
    const id = text.match(/ev_[a-f0-9]{24}/)?.[0];
    return JSON.stringify(
      text.includes('independent visual critique')
        ? {
            evidence_id: id,
            verdict: person ? 'unknown' : 'benign',
            person_present: person,
            reasons: ['fixture'],
          }
        : {
            evidence_id: id,
            subjects: person ? [{ class: 'person', confidence: 0.99 }] : [],
            person_present: person,
            activity: 'standing',
            night_ir: true,
          },
    );
  });
  const base = (ctx: SlotContext): YardRunDependencies => ({
    scope,
    modelId: 'fixture-model',
    region: 'fixture-region',
    config: () => cfg,
    authorized: () => true,
    killed: () => false,
    night: () => true,
    initialCooldown: cooldown,
    cursor: 0,
    readWakes: ctx.readWakes,
    download: async (_a, _d, ts) => {
      ctx.spendFrame();
      time += 500;
      return {
        status: 200,
        step: 2 as const,
        content_type: 'image/jpeg',
        media_origin: 'recording',
        media_timestamp: ts,
        image: Buffer.from([255, 216, 1, 2]),
      };
    },
    converse: async (content) => {
      ctx.spendModelCall();
      return converse(content);
    },
    audit: (row) => rows.push({ ...row, at: time }),
    reserve: (until) => {
      cooldown = Math.max(cooldown, until);
    },
    now: () => time,
    mono: () => time - t0,
    sleep: async (ms) => {
      time += ms;
    },
  });
  let slots = 0;
  const deps: Parameters<typeof runAttendedSession>[0] = {
    startsAt: t0,
    expiresAt: t0 + 60 * minute,
    maxEncounters: 3,
    totals: { frames: 90, modelCalls: 180 },
    cursor: 0,
    readWakes: (cursor) => {
      // One wake one minute into each slot; the second encounter has a person.
      for (const at of wakeAt)
        if (time >= at) {
          wakeAt.delete(at);
          return {
            after: cursor + 1,
            wakes: [{ ...scope, id: `w${at}`, eventTs: time, source: 'ring_event' as const }],
          };
        }
      return { after: cursor, wakes: [] };
    },
    cooldownUntil: () => cooldown,
    authorized: () => true,
    killed: () => false,
    runSlot: async (ctx) => {
      slots++;
      person = slots >= 2;
      wakeAt.add(time + minute);
      return runBoundedYard(base(ctx), {
        mode: 'attended_delivery',
        ready: async () => true,
        outputs,
      });
    },
    audit: (row) => rows.push({ ...row, at: time }),
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  return { deps, outputs, rows, cooldown: () => cooldown, t0 };
}

it('real engine: an empty encounter, the shared cooldown, then one delivered output ends it', async () => {
  const r = engineRig();
  const result = await runAttendedSession(r.deps);
  expect(result).toMatchObject({
    reason: 'output_attempted',
    encounters: 2,
    alert_attempts: 1,
    speech_attempts: 1,
    alert_acknowledgements: 1,
    speech_acknowledgements: 1,
    transport_result: 'acknowledged',
    safety_pass: true,
    drained: true,
  });
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  const started = events(r.rows, 'session_slot_started');
  const firstEnd = r.rows.find((row) => row.event === 'encounter_ended');
  expect(started).toHaveLength(2);
  expect(firstEnd).toBeDefined();
  // The second slot opened only after the first encounter's durable 10-minute cooldown.
  expect(started[1].at as number).toBeGreaterThanOrEqual((firstEnd!.at as number) + 10 * minute);
  expect((result.encounter_outcomes[0] as Record<string, unknown>).alert_attempts).toBe(0);
  expect(result.frames).toBeLessThanOrEqual(60);
});
