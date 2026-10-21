// One explicitly enabled recovery after a typed model HTTP 503 or, when listed, a model
// result that came back too old: a NEW frame, restarted dwell, unchanged freshness,
// deadline, request caps and output flags. Transports are fakes.
import { afterEach, expect, it, vi } from 'vitest';
import { runBoundedYard, boundedYardLimits } from '../src/bounded-yard.ts';
import { BedrockHttpError, converse, type ContentBlock } from '../src/bedrock.ts';
import {
  judgeFreshFrame,
  ModelUnavailableBreak,
  StaleResultBreak,
  type RecoveryCause,
} from '../src/fresh-judgement.ts';
import { createAttendedObserver } from '../src/attended-observer.ts';
import { createAttendedTest } from '../src/attended-test.ts';
import {
  deliveryAlertText,
  deliveryTestConfig,
  validateDeliveryPolicy,
  fingerprint,
  deliveryClip,
  deliveryScopePath,
  deliverySpeaker,
  type DeliveryPolicy,
} from '../src/attended-delivery-policy.ts';
import type { PipelineConfig } from '../src/pipeline.ts';

afterEach(() => vi.useRealTimers());

const scope = { accountId: 'fixture-owner', deviceId: 'fixture-camera', zone: 'front_yard' };
const isCritique = (content: ContentBlock[]) =>
  content.some((c) => 'text' in c && c.text.includes('independent visual critique'));
const unavailable = () => new BedrockHttpError('bedrock: HTTP 503', 503);

const both: RecoveryCause[] = ['model_unavailable_503', 'model_result_stale'];

function rig(opts: { causes?: RecoveryCause[] } = {}) {
  const start = Date.UTC(2026, 9, 21, 3, 0);
  let time = start,
    authorized = true,
    killed = false;
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
  // fail(model, call) decides a scripted failure for the n-th call of that model (1-based).
  let fail: (model: 'perception' | 'critique', call: number) => (() => unknown) | undefined = () =>
    undefined;
  // lag(model, call) advances the clock while that call is in flight (0 = instant).
  let lag: (model: 'perception' | 'critique', call: number) => number = () => 0;
  const calls = { perception: 0, critique: 0 };
  const download = vi.fn(async (_a: string, _d: string, ts: number) => {
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
  const converse = vi.fn(async (content: ContentBlock[], signal: AbortSignal) => {
    const model = isCritique(content) ? 'critique' : 'perception';
    const n = ++calls[model];
    const scripted = fail(model, n);
    if (scripted) return scripted() as Promise<string>;
    time += lag(model, n);
    signal.throwIfAborted();
    const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
    const id = text.match(/ev_[a-f0-9]{24}/)?.[0];
    return JSON.stringify(
      model === 'critique'
        ? { evidence_id: id, verdict: 'unknown', person_present: true, reasons: ['fixture'] }
        : {
            evidence_id: id,
            subjects: [{ class: 'person', confidence: 0.99 }],
            person_present: true,
            activity: 'standing',
            night_ir: true,
          },
    );
  });
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const abort = new AbortController();
  const deps: Parameters<typeof runBoundedYard>[0] = {
    scope,
    modelId: 'fixture-model',
    region: 'fixture-region',
    config: () => cfg,
    authorized: () => authorized,
    killed: () => killed,
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
      wakes: [{ ...scope, source: 'ring_event', id: 'fixture-wake', eventTs: time }],
    }),
    download,
    converse,
    audit: (row) => rows.push(row),
    reserve: vi.fn(),
    recoveryCauses: opts.causes ?? ['model_unavailable_503'],
    signal: abort.signal,
  };
  const delivery = { mode: 'attended_delivery' as const, ready: vi.fn(async () => true), outputs };
  const events = (name: string) => rows.filter((r) => r.event === name);
  const personCaptures = () =>
    events('evidence')
      .filter((r) => r.verdict === 'person')
      .map((r) => Number(r.capture_ts));
  return {
    deps,
    delivery,
    outputs,
    rows,
    events,
    personCaptures,
    calls,
    download,
    abort,
    start,
    script: (f: typeof fail) => {
      fail = f;
    },
    slow: (f: typeof lag) => {
      lag = f;
    },
    revoke: () => {
      authorized = false;
    },
    kill: () => {
      killed = true;
    },
    advance: (ms: number) => {
      time += ms;
    },
    // Perception call number at which the current segment has reached `dwellMs`.
    callAtDwell: (dwellMs: number) => {
      const captures = rows
        .filter((r) => r.event === 'evidence' && r.verdict === 'person')
        .map((r) => Number(r.capture_ts));
      return captures.length > 0 && captures.at(-1)! - captures[0] >= dwellMs;
    },
  };
}

// The alert threshold is reached once the controller has accepted >=10 s of capture dwell.
const alerted = (r: ReturnType<typeof rig>) => r.outputs.alert.mock.calls.length > 0;

it('a 503 before the alert restarts dwell on a strictly newer frame and completes 10/20 s once', async () => {
  const r = rig();
  r.script((model, n) =>
    model === 'perception' && n === 3 ? () => Promise.reject(unavailable()) : undefined,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    safety_pass: true,
    transport_result: 'acknowledged',
    recovery_attempts: 1,
    dwell_resets: 1,
    alert_attempts: 1,
    speech_attempts: 1,
    drained: true,
    outstanding_requests: 0,
  });
  expect(result.max_dwell_ms).toBeGreaterThanOrEqual(20000);
  const reset = r.events('dwell_reset')[0];
  const failedTs = Number(reset.failed_capture_ts);
  // The failed frame never became evidence; the next segment starts strictly after it.
  expect(r.personCaptures()).not.toContain(failedTs);
  const after = r.rows.slice(r.rows.indexOf(reset)).filter((x) => x.event === 'evidence');
  expect(after.every((x) => Number(x.capture_ts) > failedTs)).toBe(true);
  // Same encounter: armed once, started once, one restarted segment, one cleanup.
  expect(r.events('armed')).toHaveLength(1);
  expect(r.events('encounter_started')).toHaveLength(1);
  expect(r.events('dwell_restarted')).toHaveLength(1);
  expect(new Set(r.rows.filter((x) => x.session).map((x) => x.session)).size).toBe(1);
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  // The renewed 20 s speech dwell is measured from the restarted segment only.
  const speech = r.events('delivery_speech_attempt')[0];
  const segmentStart = Number(after[0].capture_ts);
  expect(Number(speech.dwell_ms)).toBeGreaterThanOrEqual(20000);
  const triggering = r.rows
    .slice(0, r.rows.indexOf(speech))
    .filter((x) => x.event === 'evidence' && x.verdict === 'person')
    .at(-1)!;
  expect(Number(speech.dwell_ms)).toBe(Number(triggering.capture_ts) - segmentStart);
});

it('a 503 after the alert never sends a second Telegram; speech needs a renewed 20 s segment', async () => {
  const r = rig();
  let failedAt: number | undefined;
  r.script((model, n) => {
    if (model !== 'perception' || failedAt !== undefined || !alerted(r)) return undefined;
    failedAt = n;
    return () => Promise.reject(unavailable());
  });
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(failedAt).toBeDefined();
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ alert_attempts: 1, speech_attempts: 1, dwell_resets: 1 });
  const reset = r.events('dwell_reset')[0];
  expect(reset).toMatchObject({ alerted: true, spoken: false });
  const speechIndex = r.rows.indexOf(r.events('delivery_speech_attempt')[0]);
  expect(speechIndex).toBeGreaterThan(r.rows.indexOf(reset));
  expect(Number(r.events('delivery_speech_attempt')[0].dwell_ms)).toBeGreaterThanOrEqual(20000);
});

it('a second 503 stops the run with no further recovery or output', async () => {
  const r = rig();
  r.script((model, n) =>
    model === 'perception' && (n === 2 || n === 4)
      ? () => Promise.reject(unavailable())
      : undefined,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    reason: 'qualification_fault',
    transport_result: 'fail',
    recovery_attempts: 1,
    dwell_resets: 1,
    alert_attempts: 0,
    speech_attempts: 0,
    drained: true,
  });
  expect(r.calls.perception).toBe(4);
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});

it.each([
  ['a sibling timeout', () => Promise.reject(new DOMException('late', 'TimeoutError'))],
  ['a sibling parse-class failure', () => Promise.reject(new SyntaxError('bad json'))],
  ['a sibling HTTP 500', () => Promise.reject(new BedrockHttpError('bedrock: HTTP 500', 500))],
])('a 503 paired with %s is not recoverable', async (_label, sibling) => {
  const r = rig();
  r.script((model, n) =>
    n !== 2 ? undefined : model === 'perception' ? () => Promise.reject(unavailable()) : sibling,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    reason: 'qualification_fault',
    transport_result: 'fail',
    recovery_attempts: 0,
    dwell_resets: 0,
    drained: true,
  });
});

it('an untyped error that merely mentions 503 is not recoverable', async () => {
  const r = rig();
  r.script((model, n) =>
    model === 'perception' && n === 2
      ? () => Promise.reject(new Error('bedrock: HTTP 503 unavailable'))
      : undefined,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({ transport_result: 'fail', recovery_attempts: 0 });
});

it('a sibling that ignores cancellation blocks recovery and reports an undrained run', async () => {
  vi.useFakeTimers();
  const r = rig();
  r.script((model, n) =>
    n !== 2
      ? undefined
      : model === 'perception'
        ? () => Promise.reject(unavailable())
        : () => new Promise(() => {}),
  );
  const running = runBoundedYard(r.deps, r.delivery);
  await vi.advanceTimersByTimeAsync(
    boundedYardLimits.recoveryDrainMs + boundedYardLimits.drainMs + 500,
  );
  const result = await running;
  expect(result).toMatchObject({
    transport_result: 'fail',
    safety_pass: false,
    recovery_attempts: 1,
    dwell_resets: 0,
    drained: false,
    alert_attempts: 0,
    speech_attempts: 0,
  });
  expect(r.events('qualification_recovery_refused' as string).length).toBe(0);
  expect(r.events('attended_delivery_recovery_refused')[0]).toMatchObject({
    reason: 'observation_not_drained',
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['authority revocation', (r: ReturnType<typeof rig>) => r.revoke()],
  ['the emergency kill switch', (r: ReturnType<typeof rig>) => r.kill()],
  ['caller cancellation', (r: ReturnType<typeof rig>) => r.abort.abort()],
  ['encounter expiry', (r: ReturnType<typeof rig>) => r.advance(60000)],
])('%s while the failed observation drains prevents any reset or output', async (_l, act) => {
  const r = rig();
  r.script((model, n) => {
    if (n !== 2) return undefined;
    if (model === 'perception')
      return () => {
        act(r);
        return Promise.reject(unavailable());
      };
    return undefined;
  });
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    dwell_resets: 0,
    alert_attempts: 0,
    speech_attempts: 0,
    drained: true,
    cleanup_succeeded: true,
  });
  expect(result.transport_result).toBe('fail');
  expect(r.events('dwell_restarted')).toHaveLength(0);
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});

it('a repeated copy of the failed frame is rejected; only a strictly newer frame restarts dwell', async () => {
  const r = rig();
  let failedTs: number | undefined;
  r.script((model, n) =>
    model === 'perception' && n === 3 ? () => Promise.reject(unavailable()) : undefined,
  );
  const original = r.download.getMockImplementation()!;
  r.download.mockImplementation(async (a: string, d: string, ts: number) => {
    const image = await original(a, d, ts);
    // Ring returns the failed frame again on the first request after the reset.
    if (failedTs === undefined && r.events('dwell_reset').length === 1) {
      failedTs = Number(r.events('dwell_reset')[0].failed_capture_ts);
      return { ...image, media_timestamp: failedTs };
    }
    return image;
  });
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(failedTs).toBeDefined();
  expect(r.personCaptures().filter((t) => t === failedTs)).toHaveLength(0);
  expect(r.events('followup_rejected').length).toBeGreaterThan(0);
  expect(result).toMatchObject({ dwell_resets: 1, speech_attempts: 1, safety_pass: true });
});

it('recovery never extends the 60-second encounter or resets request counters', async () => {
  const r = rig();
  // Fail once the encounter is ~45 s old: too little time remains for a renewed 20 s dwell.
  r.script((model) =>
    model === 'perception' && r.deps.mono!() > 45000 && r.events('dwell_reset').length === 0
      ? () => Promise.reject(unavailable())
      : undefined,
  );
  // Absent outputs keep the first segment running until the late failure.
  r.outputs.alert.mockImplementation(async () => {});
  const result = await runBoundedYard(r.deps, r.delivery);
  const ended = r.events('ended')[0];
  expect(ended).toMatchObject({ reason: 'session_expired' });
  const armedAt = Date.parse(String(r.events('armed')[0].utc));
  expect(Date.parse(String(ended.utc)) - armedAt).toBeLessThanOrEqual(60500);
  expect(result.dwell_resets).toBe(1);
  expect(result.speech_attempts).toBe(1); // spoken in the first segment, before the failure
  expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  expect(result.frames).toBe(r.events('attended_delivery_image').length);
  expect(result.model_calls).toBe(r.events('model_started').length);
  expect(result.frames).toBeLessThanOrEqual(boundedYardLimits.frames);
  expect(result.model_calls).toBeLessThanOrEqual(boundedYardLimits.modelCalls);
});

it('summary dwell is the longest single segment, never bridged across the reset', async () => {
  const r = rig();
  // First segment reaches ~7.5 s, then a 503; the second segment runs to the deadline.
  r.script((model) =>
    model === 'perception' && r.events('dwell_reset').length === 0 && r.callAtDwell(7000)
      ? () => Promise.reject(unavailable())
      : undefined,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  const reset = r.events('dwell_reset')[0];
  const before = r.personCaptures().filter((t) => t < Number(reset.failed_capture_ts));
  const after = r.personCaptures().filter((t) => t > Number(reset.failed_capture_ts));
  const segments = [before.at(-1)! - before[0], after.at(-1)! - after[0]];
  expect(result.max_dwell_ms).toBe(Math.max(...segments));
  expect(result.max_dwell_ms).toBeLessThan(after.at(-1)! - before[0]);
});

it('without the explicit flag a 503 still ends the run exactly as before', async () => {
  const r = rig({ causes: [] });
  r.script((model, n) =>
    model === 'perception' && n === 3 ? () => Promise.reject(unavailable()) : undefined,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    reason: 'qualification_fault',
    transport_result: 'fail',
    model_unavailable_recovery: 'disabled',
    stale_result_recovery: 'disabled',
    recovery_attempts: 0,
    dwell_resets: 0,
  });
  expect(r.events('attended_delivery_recovery_started')).toHaveLength(0);
});

it('settled judgement types a 503 only after its aborted sibling has settled', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  let siblingSettled = false;
  const pending = judgeFreshFrame(
    Buffer.from([255, 216]),
    98000,
    'ev_000000000000000000000000',
    scope.zone,
    {
      timezone: 'UTC',
      nightWindow: { start: '20:00', end: '06:30' },
      context: {
        mode: 'away',
        knownPets: [],
        expectedVisitors: [],
        routines: [],
        nuisanceSpecies: [],
      },
    },
    async (content, _onResponse, signal) => {
      if (!isCritique(content)) {
        await new Promise((r) => setTimeout(r, 500));
        throw unavailable();
      }
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          setTimeout(() => {
            siblingSettled = true;
            reject(signal.reason);
          }, 300),
        );
      });
    },
    undefined,
    { settleSiblings: true },
  );
  const outcome = pending.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(600);
  expect(siblingSettled).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  const error = await outcome;
  expect(siblingSettled).toBe(true);
  expect(error).toBeInstanceOf(ModelUnavailableBreak);
  expect((error as ModelUnavailableBreak).captureTs).toBe(98000);
});

it('the controller refuses a dwell restart once evidence is already lost', async () => {
  let wall = 1_000_000,
    mono = 0;
  const audit: Record<string, unknown>[] = [];
  const test = createAttendedTest({
    scope,
    outputs: { alert: async () => {}, speak: async () => {}, stop: async () => {} },
    authorize: () => true,
    ready: async () => true,
    killed: () => false,
    audit: (row) => audit.push(row),
    wall: () => wall,
    mono: () => mono,
  });
  await test.arm();
  wall += 2000;
  mono += 2000;
  await test.feed({ ...scope, id: 'a', captureTs: wall - 1000, source: 'ring', verdict: 'person' });
  wall += 6500;
  mono += 6500;
  expect(await test.restartDwell(wall - 3000, 'model_unavailable_503')).toBe(false);
  expect(audit.some((row) => row.event === 'dwell_reset')).toBe(false);
  await test.disarm();
});

it('after a restart the controller rejects evidence at or before the failed capture time', async () => {
  let wall = 1_000_000,
    mono = 0;
  const audit: Record<string, unknown>[] = [];
  const test = createAttendedTest({
    scope,
    outputs: { alert: async () => {}, speak: async () => {}, stop: async () => {} },
    authorize: () => true,
    ready: async () => true,
    killed: () => false,
    audit: (row) => audit.push(row),
    wall: () => wall,
    mono: () => mono,
  });
  await test.arm();
  const person = (id: string, captureTs: number) =>
    test.feed({ ...scope, id, captureTs, source: 'ring', verdict: 'person' });
  wall += 3000;
  mono += 3000;
  await person('a', wall - 2500);
  const failed = wall - 500; // a frame the controller never received
  expect(await test.restartDwell(failed, 'model_result_stale')).toBe(true);
  wall += 1000;
  mono += 1000;
  await person('b', failed); // same capture time as the failed frame
  await person('c', failed - 100); // older than it
  expect(audit.filter((row) => row.event === 'rejected_evidence')).toHaveLength(2);
  await person('d', failed + 1);
  expect(audit.filter((row) => row.event === 'dwell_restarted')).toHaveLength(1);
  expect(test.status()).toMatchObject({ state: 'armed', dwellResets: 1, alerted: false });
  expect(audit.find((row) => row.event === 'dwell_reset')).toMatchObject({
    reason: 'model_result_stale',
  });
  await test.disarm();
});

it('office labeling is explicit, in memory only, and policy recovery accepts two exact shapes', () => {
  const now = Date.UTC(2026, 9, 21, 16, 0);
  const chat = 'fixture-chat';
  const policy: DeliveryPolicy = {
    operation: 'one-encounter-attended-delivery',
    approvalReference: 'owner-approved-office-fixture',
    expiresAt: now + 360000,
    scopePath: deliveryScopePath,
    modelId: 'global.anthropic.claude-sonnet-4-6',
    region: 'us-east-1',
    durationMs: boundedYardLimits.durationMs,
    wakeAdmissionMs: boundedYardLimits.wakeAdmissionMs,
    frames: 30,
    modelCalls: 60,
    telegramMessages: 1,
    speechPlays: 1,
    speakerFingerprint: deliverySpeaker,
    clip: deliveryClip,
    telegramChatFingerprint: fingerprint(chat),
    daylightTest: { startsAt: now, expiresAt: now + 360000 },
    testSetting: 'office',
    recovery: { newFrameRecoveries: 1, causes: ['model_unavailable_503'] },
  };
  expect(() => validateDeliveryPolicy(policy, chat, now)).not.toThrow();
  expect(() => validateDeliveryPolicy({ ...policy, speakerVolume: 0.36 }, chat, now)).not.toThrow();
  expect(() =>
    validateDeliveryPolicy(
      { ...policy, recovery: { newFrameRecoveries: 1, causes: both } },
      chat,
      now,
    ),
  ).not.toThrow();
  for (const bad of [
    { recovery: { modelUnavailable503: 1 } }, // the superseded shape
    { recovery: { newFrameRecoveries: 2, causes: ['model_unavailable_503'] } },
    { recovery: { newFrameRecoveries: 1, causes: ['model_result_stale'] } },
    {
      recovery: { newFrameRecoveries: 1, causes: ['model_result_stale', 'model_unavailable_503'] },
    },
    { recovery: { newFrameRecoveries: 1, causes: [...both, 'model_result_stale'] } },
    { recovery: { newFrameRecoveries: 1, causes: [] } },
    { recovery: { newFrameRecoveries: 1, causes: both, extra: 1 } },
    { recovery: { causes: both } },
    { recovery: null },
    { testSetting: 'garage' },
    { speakerVolume: 0 },
    { speakerVolume: 1.01 },
    { speakerVolume: 0.365 },
    { speakerVolume: '0.36' },
    { speakerVolume: NaN },
    { speakerVolume: 0.36, testSetting: undefined }, // only an office test may lower it
  ])
    expect(() =>
      validateDeliveryPolicy({ ...policy, ...bad } as unknown as DeliveryPolicy, chat, now),
    ).toThrow('invalid_or_expired_delivery_policy');
  const household: PipelineConfig = {
    dryRun: true,
    zones: { [scope.deviceId]: 'front_yard' },
    timezone: 'UTC',
    nightWindow: { start: '20:00', end: '06:30' },
    followUpProbe: false,
    wildlifeMaxEvidenceAgeMs: 35000,
    context: {
      mode: 'home',
      knownPets: [],
      expectedVisitors: [],
      routines: [],
      nuisanceSpecies: [],
    },
  };
  const office = deliveryTestConfig(policy, household, now);
  expect(office.context).toMatchObject({ mode: 'away', testSetting: 'office' });
  expect(office.zones).toEqual({ [scope.deviceId]: 'front_yard' });
  expect(household.context).not.toHaveProperty('testSetting');
  expect(deliveryTestConfig(policy, household, now + 360000)).toBe(household);
  expect(deliveryAlertText(policy, 'run-1')).toMatch(/OFFICE test run-1/);
  expect(deliveryAlertText({}, 'run-1')).toMatch(/attended yard test run-1/);
});

it('the critique states the office setting only when the in-memory label is present', async () => {
  const prompts: string[] = [];
  const base = {
    mode: 'away' as const,
    knownPets: [],
    expectedVisitors: [],
    routines: [],
    nuisanceSpecies: [],
  };
  for (const context of [base, { ...base, testSetting: 'office' as const }])
    await judgeFreshFrame(
      Buffer.from([255, 216]),
      Date.now(),
      'ev_000000000000000000000000',
      'front_yard',
      { timezone: 'UTC', nightWindow: { start: '20:00', end: '06:30' }, context },
      async (content) => {
        const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
        if (isCritique(content)) prompts.push(text);
        return '{}';
      },
    ).catch(() => undefined);
  expect(prompts[0]).not.toMatch(/office/i);
  expect(prompts[1]).toMatch(/Supervised office test/);
  expect(prompts[1]).toMatch(/Zone: front_yard/);
  // Attempt 4's critique said "uncertain" because the frame was indoors. The office note
  // rules that out and keeps the normal verdict rules for whoever is visible.
  expect(prompts[1]).toContain(
    'Being indoors, the absence of a yard scene, or a mismatch with the zone name is never a reason for uncertain.',
  );
  expect(prompts[1]).toContain('exactly as you would in the configured zone');
  expect(prompts[1]).toContain('Use uncertain only when you cannot tell what is visible');
  // The note sits before the verdict rules it refers to, and the rules themselves are unchanged.
  expect(prompts[1].indexOf('never a reason for uncertain')).toBeLessThan(
    prompts[1].indexOf('Verdicts: benign'),
  );
  expect(prompts[1].replace(/\n[^\n]*office test[^\n]*\n[^\n]*never a reason[^\n]*/, '')).toBe(
    prompts[0],
  );
  expect(prompts[0]).not.toMatch(/indoors|never a reason/);
});

// Frames arrive ~2.5 s old in this rig; 3.6 s more in flight makes the result 6.1 s old,
// while the previous accepted evidence is still under six seconds old.
const STALE_LAG = 3600;
const staleAt =
  (call: number) =>
  (model: 'perception' | 'critique', n: number): number =>
    model === 'perception' && n === call ? STALE_LAG : 0;
// A silent drop leaves no failure row; only a stale result that spends the recovery does.
const staleBreaks = (r: ReturnType<typeof rig>) =>
  r.events('observation_failed').filter((x) => x.stage === 'result_freshness');
const staleCapture = (r: ReturnType<typeof rig>) =>
  r.events('model_completed').find((x) => Number(x.age_at_completion_ms) >= 6000)?.capture_ts;
// Summary without the field that legitimately differs between the two configurations.
const withoutCauseFlag = (summary: Record<string, unknown>) => {
  const copy = { ...summary };
  delete copy.model_unavailable_recovery;
  return copy;
};

it('a stale result mid-encounter restarts dwell and still reaches one alert and one speech', async () => {
  const r = rig({ causes: both });
  r.slow(staleAt(3));
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    safety_pass: true,
    transport_result: 'acknowledged',
    stale_result_recovery: 'enabled',
    stale_results: 1,
    recovery_attempts: 1,
    recovery_cause: 'model_result_stale',
    dwell_resets: 1,
    alert_attempts: 1,
    speech_attempts: 1,
    drained: true,
  });
  expect(result.max_dwell_ms).toBeGreaterThanOrEqual(20000);
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  const reset = r.events('dwell_reset')[0];
  expect(reset).toMatchObject({ reason: 'model_result_stale' });
  expect(staleBreaks(r)).toHaveLength(1);
  // The stale frame never becomes evidence, and nothing at or before it starts the segment.
  const stale = Number(staleCapture(r));
  expect(Number(reset.failed_capture_ts)).toBe(stale);
  expect(r.events('evidence').map((x) => Number(x.capture_ts))).not.toContain(stale);
  const after = r.rows.slice(r.rows.indexOf(reset)).filter((x) => x.event === 'evidence');
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((x) => Number(x.capture_ts) > stale)).toBe(true);
  expect(r.events('armed')).toHaveLength(1);
  expect(r.events('encounter_started')).toHaveLength(1);
  expect(r.events('dwell_restarted')).toHaveLength(1);
  expect(r.events('attended_delivery_fault')).toHaveLength(0);
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});

it('a stale result before the encounter starts leaves the recovery unused for a later 503', async () => {
  const r = rig({ causes: both });
  r.slow(staleAt(1));
  r.script((model, n) =>
    model === 'perception' && n === 4 ? () => Promise.reject(unavailable()) : undefined,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  const started = r.events('encounter_started')[0];
  const firstStale = r.events('followup_rejected').find((x) => x.reason === 'model_result_stale');
  expect(r.rows.indexOf(firstStale!)).toBeLessThan(r.rows.indexOf(started));
  expect(result).toMatchObject({
    stale_results: 1,
    recovery_attempts: 1,
    recovery_cause: 'model_unavailable_503',
    dwell_resets: 1,
    alert_attempts: 1,
    speech_attempts: 1,
    transport_result: 'acknowledged',
  });
  expect(r.events('attended_delivery_recovery_started')).toHaveLength(1);
  expect(r.events('attended_delivery_recovery_started')[0]).toMatchObject({
    reason: 'model_unavailable_503',
  });
  expect(staleBreaks(r)).toHaveLength(0);
});

it('with only the 503 cause a stale result is handled exactly as with no recovery', async () => {
  const run = async (causes: RecoveryCause[]) => {
    const r = rig({ causes });
    r.slow(staleAt(3));
    return { r, result: await runBoundedYard(r.deps, r.delivery) };
  };
  const only503 = await run(['model_unavailable_503']);
  const none = await run([]);
  for (const { r, result } of [only503, none]) {
    expect(result).toMatchObject({
      reason: 'encounter_completed',
      safety_pass: true,
      transport_result: 'inconclusive',
      stale_result_recovery: 'disabled',
      stale_results: 1,
      recovery_attempts: 0,
      dwell_resets: 0,
      alert_attempts: 0,
    });
    expect(r.events('observation_failed')).toHaveLength(0);
    expect(r.events('attended_delivery_fault')).toHaveLength(0);
  }
  const shape = ({ r }: typeof none) => r.rows.map((x) => `${x.event}:${x.reason ?? ''}`);
  expect(shape(only503)).toEqual(shape(none));
  expect(withoutCauseFlag(only503.result)).toEqual(withoutCauseFlag(none.result));
});

it('a stale result after a 503 recovery is dropped silently and never becomes a fault', async () => {
  const r = rig({ causes: both });
  r.script((model, n) =>
    model === 'perception' && n === 2 ? () => Promise.reject(unavailable()) : undefined,
  );
  r.slow(staleAt(5));
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    reason: 'encounter_completed',
    safety_pass: true,
    stale_results: 1,
    recovery_attempts: 1,
    recovery_cause: 'model_unavailable_503',
    dwell_resets: 1,
  });
  expect(result.transport_result).not.toBe('fail');
  expect(r.events('attended_delivery_fault')).toHaveLength(0);
  expect(r.events('attended_delivery_recovery_started')).toHaveLength(1);
  expect(staleBreaks(r)).toHaveLength(0);
  expect(r.events('evidence').map((x) => Number(x.capture_ts))).not.toContain(
    Number(staleCapture(r)),
  );
});

it('a 503 after a stale recovery ends the run as a fault with no second recovery', async () => {
  const r = rig({ causes: both });
  r.slow(staleAt(3));
  r.script((model, n) =>
    model === 'perception' && n === 6 ? () => Promise.reject(unavailable()) : undefined,
  );
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({
    reason: 'qualification_fault',
    transport_result: 'fail',
    recovery_attempts: 1,
    recovery_cause: 'model_result_stale',
    dwell_resets: 1,
    alert_attempts: 0,
    speech_attempts: 0,
    drained: true,
  });
  expect(r.calls.perception).toBe(6);
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
});

it('a stale recovery the controller refuses is a silent drop, not a fault', async () => {
  const r = rig({ causes: both });
  // 4.5 s in flight: by the result, the previous evidence is over six seconds old.
  r.slow((model, n) => (model === 'perception' && n === 3 ? 4500 : 0));
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(r.events('attended_delivery_recovery_refused')[0]).toMatchObject({
    reason: 'dwell_not_restartable',
  });
  expect(result).toMatchObject({
    reason: 'encounter_completed',
    safety_pass: true,
    recovery_attempts: 1,
    dwell_resets: 0,
    alert_attempts: 0,
    speech_attempts: 0,
  });
  expect(r.events('ended')[0]).toMatchObject({ reason: 'evidence_lost' });
  expect(r.events('attended_delivery_fault')).toHaveLength(0);
});

it('the observer raises a stale break only for a too-old result and only when asked', async () => {
  let time = 100000,
    lag = 4500; // requested 2 s back, so the result is 6.5 s old
  const make = (breakOnStaleResult?: () => boolean) =>
    createAttendedObserver({
      scope,
      config: () => ({
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
      }),
      download: async (_a, _d, ts) => ({
        status: 200,
        step: 2,
        content_type: 'image/jpeg',
        media_origin: 'recording',
        media_timestamp: ts,
        image: Buffer.from([255, 216, 1, 2]),
      }),
      parallelCritique: true,
      converse: async (content) => {
        time += lag / 2; // two concurrent calls share the in-flight time
        const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
        return JSON.stringify({ evidence_id: text.match(/ev_[a-f0-9]{24}/)?.[0] });
      },
      allowed: () => true,
      audit: () => {},
      breakOnStaleResult,
      now: () => time,
    });
  await expect(make(() => true).poll()).rejects.toBeInstanceOf(StaleResultBreak);
  await expect(make(() => false).poll()).resolves.toBeUndefined();
  await expect(make().poll()).resolves.toBeUndefined();
  lag = -6000; // a reversed clock is rejected but never treated as a stale break
  await expect(make(() => true).poll()).resolves.toBeUndefined();
});

it('a bounded run journals sanitized reasons for observed and stale frames, never pixels', async () => {
  const r = rig({ causes: both });
  // The 4th critique completes too late; the recovery restarts dwell on a newer frame.
  r.slow((model, n) => (model === 'critique' && n === 4 ? 6000 : 0));
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({ safety_pass: true, stale_results: 1, recovery_attempts: 1 });
  const observed = r.events('followup_observation');
  expect(observed.length).toBeGreaterThan(0);
  for (const row of [...observed, ...r.events('followup_rejected')]) {
    expect(row.critique).toEqual({
      verdict: 'unknown',
      person_present: true,
      reasons: ['fixture'],
    });
    expect(row.perception).toEqual({
      person_present: true,
      activity: 'standing',
      subjects: [{ class: 'person', confidence: 0.99 }],
      night_ir: true,
    });
  }
  expect(r.events('followup_rejected')).toHaveLength(1);
  expect(JSON.stringify(r.rows)).not.toContain(Buffer.from([255, 216, 1, 2]).toString('base64'));
});

it('a bounded run journals per-call token usage on every completed model call', async () => {
  const r = rig();
  const fake = r.deps.converse;
  // The real Bedrock client over a fake transport, so usage flows the same path as live.
  r.deps.converse = (content, signal, onResponse) =>
    converse({ region: 'fixture', modelId: 'fixture', apiKey: 'fixture' }, content, {
      onResponse,
      fetchImpl: (async () => {
        const text = await fake(content, signal, onResponse);
        return new Response(
          JSON.stringify({
            output: { message: { content: [{ text }] } },
            stopReason: 'end_turn',
            usage: { inputTokens: 1500 + text.length, outputTokens: text.length },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    }).then((result) => result.text);
  const result = await runBoundedYard(r.deps, r.delivery);
  expect(result).toMatchObject({ safety_pass: true });
  const completed = r.events('model_completed');
  expect(completed.length).toBeGreaterThanOrEqual(4);
  for (const row of completed)
    expect(row).toMatchObject({
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      stop_reason: 'end_turn',
    });
  expect(new Set(completed.map((row) => row.model))).toEqual(new Set(['perception', 'critique']));
});
