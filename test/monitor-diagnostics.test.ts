import { afterEach, expect, it, vi } from 'vitest';
import { converse, type ContentBlock } from '../src/bedrock.ts';
import { createAttendedObserver } from '../src/attended-observer.ts';
import { judgeFreshFrame } from '../src/fresh-judgement.ts';
import { createYardMonitor } from '../src/yard-monitor.ts';
import { safeError, safeUsage, stopForRuntimeFault } from '../src/monitor-diagnostics.ts';
import type { PipelineConfig } from '../src/pipeline.ts';

const scope = { accountId: 'PRIVATE_OWNER', deviceId: 'PRIVATE_CAMERA', zone: 'front_yard' };
const cfg: PipelineConfig = {
  dryRun: true,
  zones: { PRIVATE_CAMERA: 'front_yard' },
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
const jpeg = Buffer.from([255, 216, 1, 2]);
const id = 'ev_0123456789abcdef01234567';
const requestId = '01234567-89ab-cdef-0123-456789abcdef';
const privateText =
  'SECRET https://private.invalid/frame?token=SECRET PRIVATE_OWNER PRIVATE_CAMERA';
const isCritique = (content: ContentBlock[]) =>
  content.some((c) => 'text' in c && c.text.includes('independent visual critique'));
function response(content: ContentBlock[]) {
  const evidenceId = content
    .map((c) => ('text' in c ? c.text : ''))
    .join(' ')
    .match(/ev_[a-f0-9]{24}/)?.[0];
  return JSON.stringify(
    isCritique(content)
      ? { evidence_id: evidenceId, person_present: true, verdict: 'unknown', reasons: ['fixture'] }
      : {
          evidence_id: evidenceId,
          person_present: true,
          subjects: [{ class: 'person', confidence: 0.99 }],
          activity: 'standing',
          night_ir: true,
        },
  );
}
const image = (ts: number) => ({
  status: 200,
  step: 2 as const,
  content_type: 'image/jpeg',
  media_origin: 'recording',
  media_timestamp: ts,
  image: jpeg,
  request_id: requestId,
});
afterEach(() => vi.useRealTimers());

it('never serializes malicious exception fields, messages, getters, coercions or arbitrary identifiers', () => {
  const getter = vi.fn(() => {
    throw new Error(privateText);
  });
  const coercion = vi.fn(() => {
    throw new Error(privateText);
  });
  const hostile = Object.assign(new TypeError(privateText), {
    name: privateText,
    status: 503,
    requestId: privateText,
    code: { toString: coercion },
    body: privateText,
    image: jpeg,
    accountId: scope.accountId,
  });
  Object.defineProperty(hostile, 'requestId', { get: getter });
  expect(safeError(hostile)).toEqual({
    error_class: 'TypeError',
    error_category: 'http',
    http_status: 503,
  });
  expect(getter).not.toHaveBeenCalled();
  expect(coercion).not.toHaveBeenCalled();
  const hostileDom = new DOMException(privateText, 'TimeoutError');
  Object.defineProperty(hostileDom, 'name', { get: getter });
  expect(safeError(hostileDom)).toEqual({ error_class: 'TimeoutError', error_category: 'timeout' });
  expect(getter).not.toHaveBeenCalled();
  const proxy = new Proxy({}, { getOwnPropertyDescriptor: getter, getPrototypeOf: getter });
  expect(() => safeError(proxy)).not.toThrow();
  for (const error of [
    privateText,
    null,
    hostile,
    { name: privateText, status: NaN, requestId: privateText },
    proxy,
  ]) {
    expect(JSON.stringify(safeError(error))).not.toMatch(
      /SECRET|private\.invalid|PRIVATE_OWNER|PRIVATE_CAMERA/,
    );
  }
});

it('preserves structured provider HTTP metadata without leaking its body or original message', async () => {
  let caught: unknown;
  try {
    await converse({ region: 'fixture', modelId: 'fixture', apiKey: 'SECRET' }, [], {
      fetchImpl: vi.fn(
        async () =>
          new Response(privateText, { status: 429, headers: { 'x-amzn-requestid': requestId } }),
      ) as typeof fetch,
    });
  } catch (error) {
    caught = error;
  }
  expect(safeError(caught)).toEqual({
    error_class: 'Error',
    error_category: 'http',
    http_status: 429,
    request_id: requestId,
  });
});

it.each(['malformed_json', 'missing_text'] as const)(
  'retains response-header diagnostics when a provider returns %s',
  async (failure) => {
    const audit = vi.fn();
    await expect(
      judgeFreshFrame(
        jpeg,
        98000,
        id,
        scope.zone,
        cfg,
        async (_content, onResponse) =>
          (
            await converse({ region: 'fixture', modelId: 'fixture', apiKey: 'SECRET' }, [], {
              onResponse,
              fetchImpl: vi.fn(
                async () =>
                  new Response(
                    failure === 'malformed_json'
                      ? privateText
                      : JSON.stringify({ ignored: privateText }),
                    { status: 200, headers: { 'x-amzn-requestid': requestId } },
                  ),
              ) as typeof fetch,
            })
          ).text,
        { audit },
      ),
    ).rejects.toThrow();
    const failures = audit.mock.calls
      .map(([row]) => row)
      .filter((row) => row.event === 'model_failed');
    expect(failures).toHaveLength(2);
    for (const row of failures)
      expect(row).toMatchObject({
        stage: 'model_request',
        http_status: 200,
        request_id: requestId,
      });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/SECRET|private\.invalid|ignored/);
  },
);

it('records each concurrent model start/end and response metadata without prompts or images', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const audit = vi.fn();
  const pending = judgeFreshFrame(
    jpeg,
    98000,
    id,
    scope.zone,
    cfg,
    async (content, onResponse) => {
      await new Promise((r) => setTimeout(r, isCritique(content) ? 1800 : 2500));
      onResponse?.({ status: 200, requestId });
      return response(content);
    },
    { audit },
  );
  expect(audit.mock.calls.filter(([r]) => r.event === 'model_started')).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2500);
  expect((await pending).decision.kind).toBe('intruder');
  expect(audit.mock.calls.map(([r]) => r).filter((r) => r.event === 'model_completed')).toEqual([
    expect.objectContaining({
      model: 'critique',
      started_at: 100000,
      completed_at: 101800,
      duration_ms: 1800,
      age_at_completion_ms: 3800,
      http_status: 200,
      request_id: requestId,
    }),
    expect.objectContaining({
      model: 'perception',
      started_at: 100000,
      completed_at: 102500,
      duration_ms: 2500,
      age_at_completion_ms: 4500,
    }),
  ]);
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(
    /PRIVATE_OWNER|PRIVATE_CAMERA|subjects|source|bytes|standing/,
  );
});

it.each(['perception', 'critique'] as const)(
  'retains both model outcomes when %s fails first',
  async (failedModel) => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const audit = vi.fn();
    const pending = judgeFreshFrame(
      jpeg,
      98000,
      id,
      scope.zone,
      cfg,
      async (content) => {
        const model = isCritique(content) ? 'critique' : 'perception';
        await new Promise((r) => setTimeout(r, model === failedModel ? 1000 : 1500));
        if (model === failedModel) throw new DOMException(privateText, 'TimeoutError');
        return response(content);
      },
      { audit },
    );
    const outcome = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await outcome).name).toBe('TimeoutError');
    await vi.advanceTimersByTimeAsync(500);
    expect(audit.mock.calls.map(([r]) => r)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'model_failed',
          model: failedModel,
          duration_ms: 1000,
          error_class: 'TimeoutError',
          error_category: 'timeout',
        }),
        expect.objectContaining({
          event: 'model_completed',
          model: failedModel === 'perception' ? 'critique' : 'perception',
          duration_ms: 1500,
        }),
      ]),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('SECRET');
  },
);

it('captures frame request, readiness and capture timestamps independently', async () => {
  let now = 100000;
  const audit = vi.fn();
  const observer = createAttendedObserver({
    scope,
    config: () => cfg,
    allowed: () => true,
    parallelCritique: true,
    audit,
    now: () => now,
    download: async (_a, _d, ts) => {
      now += 400;
      return image(ts + 100);
    },
    converse: async (content) => response(content),
  });
  expect((await observer.poll())?.captureTs).toBe(98100);
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'frame_requested',
      requested_at: 100000,
      requested_ts: 98000,
    }),
  );
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'frame_completed',
      completed_at: 100400,
      duration_ms: 400,
      capture_ts: 98100,
      age_at_completion_ms: 2300,
      request_id: requestId,
    }),
  );
});

it.each([
  'frame_timeout',
  'frame_cancel',
  'camera_denied',
  'model_timeout',
  'model_http',
  'malformed_json',
  'null_critique',
] as const)('diagnoses the offline %s hypothesis and preserves its rejection', async (failure) => {
  const audit = vi.fn();
  const observer = createAttendedObserver({
    scope,
    config: () => cfg,
    allowed: () => true,
    parallelCritique: true,
    audit,
    now: () => 100000,
    download: async (_a, _d, ts) => {
      if (failure === 'frame_timeout') throw new DOMException(privateText, 'TimeoutError');
      if (failure === 'frame_cancel') throw new DOMException(privateText, 'AbortError');
      return { ...image(ts), status: failure === 'camera_denied' ? 403 : 200 };
    },
    converse: async (content) => {
      if (failure === 'model_timeout') throw new DOMException(privateText, 'TimeoutError');
      if (failure === 'model_http')
        throw Object.assign(new Error(privateText), { status: 503, requestId });
      if (failure === 'malformed_json') return privateText;
      if (failure === 'null_critique' && isCritique(content)) return 'null';
      return response(content);
    },
  });
  await expect(observer.poll()).rejects.toThrow();
  expect(audit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'observation_failed',
      stage: failure.startsWith('frame_')
        ? 'frame_request'
        : failure === 'camera_denied'
          ? 'frame_authorization'
          : 'model_judgement',
      error_class:
        failure === 'null_critique'
          ? 'TypeError'
          : failure.endsWith('timeout')
            ? 'TimeoutError'
            : failure === 'frame_cancel'
              ? 'AbortError'
              : 'Error',
    }),
  );
  if (failure === 'malformed_json')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'model_failed',
        stage: 'model_parse',
        error_category: 'parse',
      }),
    );
  if (failure === 'null_critique')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'judgement_failed',
        stage: 'model_validation',
        error_class: 'TypeError',
      }),
    );
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(
    /SECRET|PRIVATE_OWNER|PRIVATE_CAMERA|private\.invalid/,
  );
});

function monitorRig() {
  let now = 100000;
  const audit = vi.fn();
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const monitor = createYardMonitor({
    scope,
    authorized: () => true,
    night: () => true,
    killed: () => false,
    ready: async () => true,
    outputs: () => outputs,
    audit,
    reserve: () => {},
    initialCooldown: 0,
    now: () => now,
    mono: () => now - 100000,
  });
  const wake = () => monitor.wake({ ...scope, source: 'ring_event', id: 'wake', eventTs: now });
  const feed = async (elapsed: number, age = 0) => {
    now = 100000 + elapsed + age;
    await monitor.feed({
      ...scope,
      id: `fixture-${elapsed}`,
      source: 'ring',
      verdict: 'person',
      captureTs: 100000 + elapsed,
    });
  };
  return { monitor, audit, outputs, wake, feed, now: () => now };
}

it('keeps exactly 9997 ms below alert, alerts at 10000, and speaks at 20000', async () => {
  const r = monitorRig();
  try {
    await r.wake();
    for (const n of [0, 3354, 6848, 9997]) await r.feed(n);
    expect(r.outputs.alert).not.toHaveBeenCalled();
    await r.feed(10000);
    expect(r.outputs.alert).toHaveBeenCalledTimes(1);
    for (const n of [15000, 19999]) await r.feed(n);
    expect(r.outputs.speak).not.toHaveBeenCalled();
    await r.feed(20000);
    expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  } finally {
    await r.monitor.stop('fixture');
  }
});

it('a diagnosed fault after 9997 ms accepted dwell disarms, cleans up once and never re-arms or retries', async () => {
  const r = monitorRig();
  await r.wake();
  for (const n of [0, 3354, 6848, 9997]) await r.feed(n);
  await stopForRuntimeFault(
    r.monitor,
    r.audit,
    'observe',
    new DOMException(privateText, 'TimeoutError'),
    r.now,
  );
  expect(r.monitor.status()).toMatchObject({
    running: false,
    phase: 'DISARMED',
    reason: 'source_or_runtime_fault',
  });
  expect(r.monitor.current()?.status()).toMatchObject({
    state: 'ended',
    cleanupSucceeded: true,
    alerted: false,
    spoken: false,
  });
  await r.feed(10000);
  await r.wake();
  await r.monitor.stop('fixture');
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
  expect(r.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'runtime_fault',
      stage: 'observe',
      error_category: 'timeout',
    }),
  );
});

it('a broken diagnostic sink cannot hide the original failure or prevent cleanup', async () => {
  const r = monitorRig();
  await r.wake();
  await stopForRuntimeFault(
    r.monitor,
    () => {
      throw new Error(privateText);
    },
    'observe',
    new TypeError(privateText),
  );
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.monitor.status().running).toBe(false);
  const observer = createAttendedObserver({
    scope,
    config: () => cfg,
    allowed: () => true,
    parallelCritique: true,
    audit: () => {
      throw new Error('audit');
    },
    now: () => 100000,
    download: async () => {
      throw new TypeError('original');
    },
    converse: async () => '',
  });
  await expect(observer.poll()).rejects.toThrow('original');
});

it('cancellation during both parallel model calls records both failures and keeps cleanup final', async () => {
  const r = monitorRig();
  await r.wake();
  const signal = r.monitor.current()!.signal;
  const observer = createAttendedObserver({
    scope,
    config: () => cfg,
    allowed: () => !signal.aborted,
    parallelCritique: true,
    audit: r.audit,
    now: r.now,
    download: async (_a, _d, ts) => image(ts),
    converse: async () =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new DOMException(privateText, 'AbortError')),
          { once: true },
        ),
      ),
  });
  const pending = observer.poll().catch((error) => error);
  await Promise.resolve();
  await Promise.resolve();
  await r.monitor.stop('fixture_cancel');
  expect((await pending).name).toBe('AbortError');
  expect(
    r.audit.mock.calls
      .map(([row]) => row)
      .filter((row) => row.event === 'model_failed' && row.error_category === 'cancelled'),
  ).toHaveLength(2);
  expect(r.outputs.stop).toHaveBeenCalledTimes(1);
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
});

it('diagnostics do not relax the six-second completed-result freshness gate', async () => {
  let now = 100000;
  const audit = vi.fn();
  const observer = createAttendedObserver({
    scope,
    config: () => cfg,
    allowed: () => true,
    parallelCritique: true,
    audit,
    now: () => now,
    download: async (_a, _d, ts) => image(ts),
    converse: async (content) => {
      now = 104000;
      return response(content);
    },
  });
  expect(await observer.poll()).toBeUndefined();
  expect(audit).toHaveBeenCalledWith({ event: 'followup_rejected', reason: 'model_result_stale' });
});

it('keeps only whole token counts and fixed stop labels, without invoking getters', () => {
  expect(safeUsage({ inputTokens: 1520, outputTokens: 0, stopReason: 'end_turn' })).toEqual({
    input_tokens: 1520,
    output_tokens: 0,
    stop_reason: 'end_turn',
  });
  expect(safeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_001 })).toEqual({
    input_tokens: 1_000_000,
  });
  const getter = vi.fn(() => 5);
  const withGetter = { stopReason: 'max_tokens' };
  Object.defineProperty(withGetter, 'inputTokens', { get: getter });
  expect(safeUsage(withGetter)).toEqual({ stop_reason: 'max_tokens' });
  expect(getter).not.toHaveBeenCalled();
  for (const bad of [
    undefined,
    null,
    privateText,
    { inputTokens: -1, outputTokens: 2.5, stopReason: privateText },
    { inputTokens: NaN, outputTokens: Infinity, stopReason: 'END_TURN' },
    { inputTokens: '12', outputTokens: 12n, stopReason: { toString: () => 'end_turn' } },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error(privateText);
        },
      },
    ),
  ])
    expect(safeUsage(bad)).toEqual({});
});

it('adds checked per-call token usage to model_completed and changes nothing else in the row', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const audit = vi.fn();
  const usage = {
    perception: { inputTokens: 1520, outputTokens: 61, stopReason: 'end_turn' },
    critique: { inputTokens: -4, outputTokens: 33, stopReason: privateText },
  };
  await judgeFreshFrame(
    jpeg,
    98000,
    id,
    scope.zone,
    cfg,
    async (content, onResponse) =>
      (
        await converse({ region: 'fixture', modelId: 'fixture', apiKey: 'SECRET' }, content, {
          onResponse,
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  output: { message: { content: [{ text: response(content) }] } },
                  stopReason: usage[isCritique(content) ? 'critique' : 'perception'].stopReason,
                  usage: usage[isCritique(content) ? 'critique' : 'perception'],
                }),
                { status: 200, headers: { 'x-amzn-requestid': requestId } },
              ),
          ) as typeof fetch,
        })
      ).text,
    { audit },
  );
  const completed = audit.mock.calls.map(([r]) => r).filter((r) => r.event === 'model_completed');
  const base = {
    event: 'model_completed',
    stage: 'model_request',
    started_at: 100000,
    completed_at: 100000,
    duration_ms: 0,
    capture_ts: 98000,
    age_at_completion_ms: 2000,
    http_status: 200,
    request_id: requestId,
  };
  expect(completed).toEqual(
    expect.arrayContaining([
      {
        ...base,
        model: 'perception',
        input_tokens: 1520,
        output_tokens: 61,
        stop_reason: 'end_turn',
      },
      { ...base, model: 'critique', output_tokens: 33 },
    ]),
  );
  expect(completed).toHaveLength(2);
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(/SECRET|private\.invalid|PRIVATE_OWNER/);
});
