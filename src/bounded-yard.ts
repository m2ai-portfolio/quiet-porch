// Bounded orchestration. All actual transports are supplied explicitly by the attended CLI.
import { createHash } from 'node:crypto';
import { createYardMonitor } from './yard-monitor.ts';
import { createAttendedObserver } from './attended-observer.ts';
import { pollEncounterObservation } from './encounter-observation.ts';
import type { MotionWake } from './attended-source.ts';
import type { TestScope, TestOutputs } from './attended-test.ts';
import type { PipelineConfig } from './pipeline.ts';
import type { Download } from './frames.ts';
import type { ContentBlock } from './bedrock.ts';
import { safeError, type DiagnosticConverse } from './monitor-diagnostics.ts';

export const boundedYardLimits = {
  durationMs: 360000,
  wakeAdmissionMs: 300000,
  frames: 30,
  modelCalls: 60,
  frameTimeoutMs: 2000,
  modelTimeoutMs: 4000,
  drainMs: 5000,
} as const;

export interface YardRunDependencies {
  scope: TestScope;
  modelId: string;
  region: string;
  config: () => PipelineConfig;
  authorized: () => boolean;
  killed: () => boolean;
  night: () => boolean;
  initialCooldown: number;
  cursor: number;
  readWakes: (cursor: number) => { after: number; wakes: MotionWake[] };
  download: (
    account: string,
    device: string,
    timestamp: number,
    options: { keepImage?: boolean; signal: AbortSignal },
  ) => ReturnType<Download>;
  converse: (
    content: ContentBlock[],
    signal: AbortSignal,
    onResponse: Parameters<DiagnosticConverse>[1],
  ) => Promise<string>;
  audit: (row: Record<string, unknown>) => void;
  reserve: (until: number) => void;
  signal?: AbortSignal;
  now?: () => number;
  mono?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type YardRunMode =
  | { mode: 'output_disabled' }
  | { mode: 'attended_delivery'; ready: () => Promise<boolean>; outputs: TestOutputs };

export async function runBoundedYard(deps: YardRunDependencies, delivery: YardRunMode) {
  const live = delivery.mode === 'attended_delivery';
  const now = deps.now ?? Date.now;
  const mono = deps.mono ?? (() => performance.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = mono();
  const cancellation = new AbortController();
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, cancellation.signal])
    : cancellation.signal;
  const pending = new Set<Promise<unknown>>();
  let frames = 0,
    modelCalls = 0,
    observations = 0,
    staleResults = 0;
  let alertAttempts = 0,
    speechAttempts = 0,
    alertAcks = 0,
    speechAcks = 0,
    speechMargin: number | undefined;
  let firstCapture: number | undefined,
    lastCapture: number | undefined,
    maxDwell = 0;
  let admitted = false,
    cursor = deps.cursor,
    finalReason = 'no_encounter';
  let safetyViolation = false,
    fault = false,
    auditFailed = false;
  const audit = (row: Record<string, unknown>) => {
    // Simulations are explicitly labelled; real ACKs still require owner confirmation.
    const event =
      !live && (row.event === 'alert_ack' || row.event === 'speak_ack')
        ? `simulated_${row.event}`
        : live && typeof row.event === 'string'
          ? row.event.replace(/^qualification_/, 'attended_delivery_')
          : row.event;
    const safeRow = { ...row };
    delete safeRow.scope;
    try {
      deps.audit({
        ...safeRow,
        event,
        mode: delivery.mode,
        model_id: deps.modelId,
        region: deps.region,
      });
    } catch {
      auditFailed = true;
      fault = true;
      cancellation.abort();
    }
    if (row.event === 'cleanup_failed' || row.event === 'output_failed') fault = true;
    if (row.event === 'alert_ack') alertAcks++;
    if (row.event === 'speak_ack') speechAcks++;
    if (row.event === 'followup_rejected' && row.reason === 'model_result_stale') staleResults++;
    // Only the controller's accepted evidence counts, never an observer-returned frame
    // subsequently rejected for predating arming, a capture gap or duplicate identity.
    if (row.event === 'evidence' && typeof row.capture_ts === 'number') {
      observations++;
      const age = now() - row.capture_ts;
      if (age < 0 || age >= 6000) safetyViolation = true;
      if (row.verdict === 'person') {
        if (lastCapture !== undefined && row.capture_ts - lastCapture >= 6000)
          safetyViolation = true;
        firstCapture ??= row.capture_ts;
        lastCapture = row.capture_ts;
        maxDwell = lastCapture - firstCapture;
      }
    }
  };
  const track = async <T>(operation: () => Promise<T>, requestSignal: AbortSignal) => {
    requestSignal.throwIfAborted();
    const request = Promise.resolve().then(operation);
    pending.add(request);
    void request.then(
      () => pending.delete(request),
      () => pending.delete(request),
    );
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', onAbort, { once: true });
      if (requestSignal.aborted) onAbort();
    });
    try {
      return await Promise.race([request, aborted]);
    } finally {
      requestSignal.removeEventListener('abort', onAbort);
    }
  };
  let cleanup: Promise<void> | undefined;
  let cleanupSucceeded = true;
  const monitor = createYardMonitor({
    scope: deps.scope,
    authorized: () => !signal.aborted && deps.authorized(),
    killed: deps.killed,
    night: deps.night,
    ready: async () =>
      deps.authorized() &&
      !deps.killed() &&
      !signal.aborted &&
      (delivery.mode === 'output_disabled' || (await track(delivery.ready, signal))),
    initialCooldown: deps.initialCooldown,
    reserve: deps.reserve,
    audit,
    now,
    mono,
    outputs: () => ({
      async alert(id, outputSignal, allowed, guard) {
        outputSignal.throwIfAborted();
        guard.assert();
        if (alertAttempts >= 1) throw new Error('alert_cap');
        alertAttempts++;
        audit({
          event: live ? 'delivery_alert_attempt' : 'would_alert',
          remaining_freshness_ms: guard.remainingMs(),
          dwell_ms: maxDwell,
        });
        if (delivery.mode === 'attended_delivery')
          await track(() => delivery.outputs.alert(id, outputSignal, allowed, guard), outputSignal);
      },
      async speak(id, outputSignal, allowed, guard) {
        outputSignal.throwIfAborted();
        guard.assert();
        if (speechAttempts >= 1 || alertAcks !== 1)
          throw new Error('speech_cap_or_missing_alert_ack');
        speechAttempts++;
        speechMargin = guard.remainingMs();
        audit({
          event: live ? 'delivery_speech_attempt' : 'would_speak',
          remaining_freshness_ms: speechMargin,
          dwell_ms: maxDwell,
        });
        if (delivery.mode === 'attended_delivery')
          await track(() => delivery.outputs.speak(id, outputSignal, allowed, guard), outputSignal);
      },
      async stop() {
        if (delivery.mode === 'attended_delivery') {
          // Cleanup remains permitted after revocation. Track it even if the caller's
          // deadline wins; a missing idle acknowledgement must never become a pass.
          cleanup ??= (async () => {
            cleanupSucceeded = false;
            try {
              await delivery.outputs.stop();
              cleanupSucceeded = true;
            } catch (error) {
              fault = true;
              throw error;
            }
          })();
          pending.add(cleanup);
          void cleanup.then(
            () => pending.delete(cleanup!),
            () => pending.delete(cleanup!),
          );
          await cleanup;
        }
        audit({ event: 'qualification_cleanup', physical_output: live });
      },
    }),
  });
  const timedSignal = (timeout: number) =>
    AbortSignal.any([signal, monitor.current()!.signal, AbortSignal.timeout(timeout)]);
  const observer = createAttendedObserver({
    scope: deps.scope,
    config: deps.config,
    parallelCritique: true,
    now,
    audit,
    allowed: () =>
      monitor.status().running &&
      monitor.current()?.status().state === 'armed' &&
      !signal.aborted &&
      deps.authorized() &&
      !deps.killed(),
    download: async (account, device, timestamp, options) => {
      if (frames >= boundedYardLimits.frames) throw new Error('qualification_frame_cap');
      signal.throwIfAborted();
      frames++;
      const requestSignal = timedSignal(boundedYardLimits.frameTimeoutMs);
      const result = await track(
        () =>
          deps.download(account, device, timestamp, {
            ...options,
            signal: requestSignal,
          }),
        requestSignal,
      );
      if (result.image)
        audit({
          event: 'qualification_image',
          requested_ts: timestamp,
          capture_ts: result.media_timestamp,
          image_sha256: createHash('sha256').update(result.image).digest('hex'),
        });
      return result;
    },
    converse: async (content, onResponse) => {
      if (modelCalls >= boundedYardLimits.modelCalls) throw new Error('qualification_model_cap');
      signal.throwIfAborted();
      modelCalls++;
      const requestSignal = timedSignal(boundedYardLimits.modelTimeoutMs);
      return track(() => deps.converse(content, requestSignal, onResponse), requestSignal);
    },
  });
  const check = async () => {
    if (mono() < started) {
      fault = true;
      finalReason = 'clock_reversed';
      cancellation.abort();
    }
    if (mono() - started >= boundedYardLimits.durationMs) {
      finalReason = 'qualification_deadline';
      cancellation.abort();
    }
    if (signal.aborted)
      void monitor.stop('qualification_cancelled').catch(() => {
        fault = true;
      });
    else await track(() => monitor.tick(), signal);
  };
  const watchdog = setInterval(() => {
    void check().catch(() => {
      fault = true;
      cancellation.abort();
    });
  }, 250);
  try {
    audit({
      event: 'qualification_started',
      limits: boundedYardLimits,
      speaker_readiness: live ? 'checked_on_admission' : 'not_measured',
      physical_delivery: live ? 'owner_confirmation_required' : 'not_evaluated',
    });
    if (!deps.authorized() || deps.killed() || !deps.night() || now() < deps.initialCooldown)
      throw new Error('qualification_admission_failed');
    while (!signal.aborted && monitor.status().running) {
      await check();
      if (signal.aborted || !monitor.status().running) break;
      if (!admitted && mono() - started < boundedYardLimits.wakeAdmissionMs) {
        const batch = deps.readWakes(cursor);
        cursor = batch.after;
        for (const wake of batch.wakes) {
          await track(() => monitor.wake(wake), signal);
          if (monitor.current()) {
            admitted = true;
            break;
          }
        }
      }
      if (!admitted && mono() - started >= boundedYardLimits.wakeAdmissionMs) break;
      const current = monitor.current();
      if (current?.status().state === 'armed') {
        const frame = await pollEncounterObservation(current, () => observer.poll(), audit);
        await track(() => monitor.tick(), signal);
        if (frame) {
          const age = now() - frame.captureTs;
          audit({
            event: 'qualification_observer_result',
            capture_ts: frame.captureTs,
            age_ms: age,
            verdict: frame.verdict,
          });
          await track(() => monitor.feed(frame), signal);
        }
      }
      if (admitted && !monitor.current()) {
        finalReason = 'encounter_completed';
        break;
      }
      await sleep(250);
    }
  } catch (error) {
    if (!signal.aborted) {
      fault = true;
      finalReason = 'qualification_fault';
    }
    audit({ event: 'qualification_fault', ...safeError(error) });
  } finally {
    clearInterval(watchdog);
    if (!monitor.status().running && !signal.aborted) {
      fault = true;
      finalReason = monitor.status().reason ?? 'monitor_stopped';
    } else if (deps.signal?.aborted) {
      fault = true;
      finalReason = 'qualification_cancelled';
    }
    cancellation.abort();
    const stopping = monitor.stop('qualification_complete').catch(() => {
      fault = true;
    });
    pending.add(stopping);
    void stopping.then(() => pending.delete(stopping));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.allSettled([...pending]).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundedYardLimits.drainMs);
    }),
  ]);
  clearTimeout(timer);
  const safetyPass =
    !safetyViolation &&
    !auditFailed &&
    cleanupSucceeded &&
    drained &&
    frames <= boundedYardLimits.frames &&
    modelCalls <= boundedYardLimits.modelCalls &&
    alertAttempts <= 1 &&
    speechAttempts <= 1;
  const observationResult =
    !safetyPass || fault
      ? 'fail'
      : maxDwell >= 20000 && alertAcks === 1 && speechAcks === 1
        ? speechMargin !== undefined && speechMargin >= 1000
          ? 'pass'
          : 'insufficient_margin'
        : 'inconclusive';
  const summary = {
    event: live ? 'attended_delivery_finished' : 'qualification_finished',
    mode: delivery.mode,
    reason: finalReason,
    safety_pass: safetyPass,
    observation_result: live ? 'not_evaluated' : observationResult,
    transport_result: !live
      ? 'not_evaluated'
      : !safetyPass || fault
        ? 'fail'
        : alertAcks === 1 && speechAcks === 1
          ? 'acknowledged'
          : 'inconclusive',
    physical_delivery: live ? 'owner_confirmation_required' : 'not_evaluated',
    speaker_readiness: live ? 'checked_on_admission' : 'not_measured',
    frames,
    model_calls: modelCalls,
    observations,
    stale_results: staleResults,
    max_dwell_ms: maxDwell,
    alert_attempts: alertAttempts,
    speech_attempts: speechAttempts,
    alert_acknowledgements: alertAcks,
    speech_acknowledgements: speechAcks,
    speech_remaining_ms: speechMargin,
    cleanup_succeeded: cleanupSucceeded,
    outstanding_requests: pending.size,
    drained,
    elapsed_ms: mono() - started,
  };
  audit(summary);
  return auditFailed
    ? {
        ...summary,
        safety_pass: false,
        observation_result: 'fail',
        transport_result: live ? 'fail' : 'not_evaluated',
      }
    : summary;
}
