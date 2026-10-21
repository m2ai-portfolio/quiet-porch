import { afterEach, expect, it, vi } from 'vitest';
import { runYardQualification, qualificationLimits } from '../src/yard-qualification.ts';
import type { ContentBlock } from '../src/bedrock.ts';
import type { PipelineConfig } from '../src/pipeline.ts';

afterEach(() => vi.useRealTimers());
function rig(wakeDelayMs = 0) {
  const start = Date.UTC(2026, 9, 21, 3, 0);
  let time = start,
    wakes = true,
    person = true;
  const scope = { accountId: 'fixture-owner', deviceId: 'fixture-camera', zone: 'front_yard' };
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
  const download = vi.fn(async (_account: string, _device: string, ts: number) => {
    time += 500;
    return {
      status: 200,
      step: 2 as const,
      content_type: 'image/jpeg',
      media_origin: 'recording',
      media_timestamp: ts,
      image: Buffer.from([255, 216, 1, 2]),
    };
  });
  const converse = vi.fn(async (content: ContentBlock[]) => {
    const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
    const id = text.match(/ev_[a-f0-9]{24}/)?.[0];
    const present = person && time - start < wakeDelayMs + 30000;
    return JSON.stringify(
      text.includes('independent visual critique')
        ? {
            evidence_id: id,
            verdict: present ? 'unknown' : 'benign',
            person_present: present,
            reasons: ['fixture only'],
          }
        : {
            evidence_id: id,
            subjects: present ? [{ class: 'person', confidence: 0.99 }] : [],
            person_present: present,
            activity: 'standing',
            night_ir: true,
          },
    );
  });
  const deps: Parameters<typeof runYardQualification>[0] = {
    scope,
    modelId: 'fixture-model',
    region: 'fixture-region',
    config: () => cfg,
    authorized: () => true,
    killed: () => false,
    night: () => true,
    initialCooldown: 0,
    cursor: 0,
    now: () => time,
    mono: () => time - start,
    sleep: async (ms) => {
      time += ms;
    },
    readWakes: (cursor) => ({
      after: cursor + 1,
      wakes:
        wakes && time - start >= wakeDelayMs
          ? [{ ...scope, source: 'ring_event', id: 'fixture-wake', eventTs: time }]
          : [],
    }),
    download,
    converse,
    audit: (row) => rows.push(row),
    reserve: vi.fn(),
  };
  return {
    deps,
    rows,
    download,
    converse,
    noWake: () => {
      wakes = false;
    },
    empty: () => {
      person = false;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

it('qualifies simulated 10/20s dwell without recording real delivery or counting pre-arm frames', async () => {
  const r = rig();
  const result = await runYardQualification(r.deps);
  expect(result).toMatchObject({
    safety_pass: true,
    observation_result: 'pass',
    would_alert: 1,
    would_speak: 1,
    physical_delivery: 'not_evaluated',
    speaker_readiness: 'not_measured',
    drained: true,
    outstanding_requests: 0,
  });
  expect(result.speech_remaining_ms).toBeGreaterThanOrEqual(1000);
  expect(result.observations).toBe(r.rows.filter((row) => row.event === 'evidence').length);
  expect(
    r.rows.filter((row) => row.event === 'qualification_observer_result').length,
  ).toBeGreaterThan(result.observations);
  expect(r.rows.some((row) => row.event === 'alert_ack' || row.event === 'speak_ack')).toBe(false);
  expect(r.rows.filter((row) => row.event === 'simulated_speak_ack')).toHaveLength(1);
  expect(r.rows.every((row) => row.mode === 'output_disabled')).toBe(true);
  expect(result.frames).toBeLessThanOrEqual(qualificationLimits.frames);
  expect(result.model_calls).toBeLessThanOrEqual(qualificationLimits.modelCalls);
});

it('a quiet yard is inconclusive, with zero camera/model calls after admission expires', async () => {
  const r = rig();
  r.noWake();
  const result = await runYardQualification(r.deps);
  expect(result).toMatchObject({
    safety_pass: true,
    observation_result: 'inconclusive',
    frames: 0,
    model_calls: 0,
  });
  expect(result.elapsed_ms).toBe(qualificationLimits.wakeAdmissionMs);
});

it('admits a wake after three minutes of idle waiting and still requires full observed dwell', async () => {
  const r = rig(180000);
  const started = r.deps.now!();
  const result = await runYardQualification(r.deps);
  expect(result).toMatchObject({
    safety_pass: true,
    observation_result: 'pass',
    would_alert: 1,
    would_speak: 1,
    drained: true,
  });
  expect(result.max_dwell_ms).toBeGreaterThanOrEqual(20000);
  expect(result.elapsed_ms).toBeGreaterThanOrEqual(200000);
  expect(result.elapsed_ms).toBeLessThanOrEqual(qualificationLimits.durationMs);
  expect(
    r.rows
      .filter((row) => row.event === 'evidence')
      .every((row) => Number(row.capture_ts) >= started + 180000),
  ).toBe(true);
  expect(result.frames).toBeLessThanOrEqual(qualificationLimits.frames);
  expect(result.model_calls).toBeLessThanOrEqual(qualificationLimits.modelCalls);
});

it('an empty scene cannot qualify person dwell or simulated speech', async () => {
  const r = rig();
  r.empty();
  const result = await runYardQualification(r.deps);
  expect(result).toMatchObject({
    observation_result: 'inconclusive',
    would_speak: 0,
    would_alert: 0,
  });
});

it('stale analyses are counted and never become simulated outputs', async () => {
  const r = rig();
  const original = r.converse.getMockImplementation()!;
  r.converse.mockImplementation(async (content) => {
    r.advance(2500);
    return original(content);
  });
  const result = await runYardQualification(r.deps);
  expect(result.stale_results).toBeGreaterThan(0);
  expect(result.would_speak).toBe(0);
  expect(result.observation_result).not.toBe('pass');
});

it('denied camera access is a failed qualification without retry', async () => {
  const r = rig();
  r.download.mockRejectedValueOnce(new Error('camera denied'));
  const result = await runYardQualification(r.deps);
  expect(result.observation_result).toBe('fail');
  expect(result.frames).toBe(1);
  expect(result.model_calls).toBe(0);
});

it('audit failure cancels admission and leaves no watchdog running', async () => {
  vi.useFakeTimers();
  const r = rig();
  r.deps.audit = () => {
    throw new Error('full disk');
  };
  const result = await runYardQualification(r.deps);
  expect(result).toMatchObject({ safety_pass: false, observation_result: 'fail', frames: 0 });
  expect(vi.getTimerCount()).toBe(0);
});

it('an abort-ignoring request reaches bounded drain failure rather than hanging forever', async () => {
  vi.useFakeTimers();
  const r = rig();
  const abort = new AbortController();
  r.deps.signal = abort.signal;
  r.download.mockImplementation(() => new Promise(() => {}));
  const result = runYardQualification(r.deps);
  setTimeout(() => abort.abort(), 100);
  await vi.advanceTimersByTimeAsync(5200);
  expect(await result).toMatchObject({
    safety_pass: false,
    observation_result: 'fail',
    drained: false,
    outstanding_requests: 1,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('monotonic reversal cannot pass qualification', async () => {
  const r = rig();
  r.deps.sleep = async () => {
    r.advance(-1000);
  };
  const result = await runYardQualification(r.deps);
  expect(result).toMatchObject({ reason: 'clock_reversed', observation_result: 'fail' });
});

// Real transports are mocked: these test authority and observable delivery sequencing.
import { runBoundedYard } from '../src/bounded-yard.ts';
function deliveryRig() {
  const r = rig();
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const delivery = { mode: 'attended_delivery' as const, ready: vi.fn(async () => true), outputs };
  return { ...r, delivery, outputs };
}
it('one real-output encounter reserves cooldown before exactly one alert and speech', async () => {
  const r = deliveryRig();
  const order: string[] = [];
  r.deps.reserve = vi.fn(() => {
    order.push('reserve');
  });
  r.outputs.alert.mockImplementation(async () => {
    order.push('alert');
  });
  r.outputs.speak.mockImplementation(async () => {
    order.push('speak');
  });
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    safety_pass: true,
    transport_result: 'acknowledged',
    physical_delivery: 'owner_confirmation_required',
    alert_attempts: 1,
    speech_attempts: 1,
    alert_acknowledgements: 1,
    speech_acknowledgements: 1,
    drained: true,
  });
  expect(order.slice(0, 3)).toEqual(['reserve', 'alert', 'speak']);
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.rows.some((row) => String(row.event).startsWith('simulated_'))).toBe(false);
});
it('no wake causes zero output attempts or camera/model calls in delivery mode', async () => {
  const r = deliveryRig();
  r.noWake();
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    frames: 0,
    model_calls: 0,
    alert_attempts: 0,
    speech_attempts: 0,
    transport_result: 'inconclusive',
  });
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
});
it('Telegram failure is not retried and prevents speech', async () => {
  const r = deliveryRig();
  r.outputs.alert.mockRejectedValueOnce(new Error('ambiguous'));
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    transport_result: 'fail',
    alert_attempts: 1,
    alert_acknowledgements: 0,
    speech_attempts: 0,
    drained: true,
  });
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).not.toHaveBeenCalled();
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.deps.reserve).toHaveBeenCalled();
});
it('stale results cannot dispatch either real output', async () => {
  const r = deliveryRig();
  const original = r.converse.getMockImplementation()!;
  r.converse.mockImplementation(async (content) => {
    r.advance(2500);
    return original(content);
  });
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result.stale_results).toBeGreaterThan(0);
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
});
it('cancellation during speech joins cleanup and retains attempt without ACK', async () => {
  const r = deliveryRig();
  const abort = new AbortController();
  r.deps.signal = abort.signal;
  r.outputs.speak.mockImplementation(async () => {
    abort.abort();
  });
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    transport_result: 'fail',
    speech_attempts: 1,
    speech_acknowledgements: 0,
    drained: true,
  });
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});
it('abort-ignoring speech is reported as undrained after bounded cleanup allowance', async () => {
  vi.useFakeTimers();
  const r = deliveryRig();
  const abort = new AbortController();
  r.deps.signal = abort.signal;
  r.outputs.speak.mockImplementation(() => {
    abort.abort();
    return new Promise(() => {});
  });
  const running = runBoundedYard(r.deps, r.delivery);
  await vi.advanceTimersByTimeAsync(5100);
  expect(await running).toMatchObject({
    safety_pass: false,
    transport_result: 'fail',
    drained: false,
  });
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('failed cleanup cannot report acknowledged transport as a passing run', async () => {
  const r = deliveryRig();
  r.outputs.stop.mockRejectedValueOnce(new Error('idle not verified'));
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result.transport_result).toBe('fail');
});
it('the simulation wrapper ignores injected output dependencies', async () => {
  const r = deliveryRig();
  const result = await runYardQualification({ ...r.deps, ...r.delivery });
  expect(result.observation_result).toBe('pass');
  expect(result.transport_result).toBe('not_evaluated');
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
  expect(r.outputs.stop).not.toHaveBeenCalled();
});
it('forced final shutdown after both ACKs fails safety when cleanup rejects', async () => {
  const r = deliveryRig();
  const abort = new AbortController();
  r.deps.signal = abort.signal;
  r.deps.audit = (row) => {
    r.rows.push(row);
    if (row.event === 'speak_ack') abort.abort();
  };
  r.outputs.stop.mockRejectedValueOnce(new Error('idle unavailable'));
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    alert_acknowledgements: 1,
    speech_acknowledgements: 1,
    safety_pass: false,
    cleanup_succeeded: false,
    transport_result: 'fail',
    drained: true,
  });
});
it('hung cleanup exits with a failed drain and unverified cleanup', async () => {
  vi.useFakeTimers();
  const r = deliveryRig();
  const abort = new AbortController();
  r.deps.signal = abort.signal;
  r.deps.audit = (row) => {
    r.rows.push(row);
    if (row.event === 'speak_ack') abort.abort();
  };
  r.outputs.stop.mockImplementation(() => new Promise(() => {}));
  const running = runBoundedYard(r.deps, r.delivery);
  await vi.advanceTimersByTimeAsync(5100);
  expect(await running).toMatchObject({
    safety_pass: false,
    transport_result: 'fail',
    drained: false,
    cleanup_succeeded: false,
  });
  expect(vi.getTimerCount()).toBe(0);
});
