// Bounded orchestration. All actual transports are supplied explicitly by the attended CLI.
import { createHash } from 'node:crypto';
import { createYardMonitor } from './yard-monitor.ts';
import { createAttendedObserver } from './attended-observer.ts';
import { pollEncounterObservation } from './encounter-observation.ts';
import { ModelUnavailableBreak, StaleResultBreak, type RecoveryCause } from './fresh-judgement.ts';
import type { MotionWake } from './attended-source.ts';
import type { TestScope, TestOutputs, TestEvidence } from './attended-test.ts';
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
  // Used only when a run explicitly enables new-frame recovery; shared by every cause.
  recoveries: 1,
  recoveryDrainMs: 1000,
  // Follow-up frames are requested this far behind now (was 2000). Ring answers 416 for
  // timestamps closer than about 1 to 1.5 s to real time (friction log, 2026-10-21).
  followUpLookbackMs: 1500,
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
  // Causes allowed to spend the run's one recovery on a NEW frame inside the same
  // encounter: a typed model HTTP 503, and optionally a result that came back too old.
  recoveryCauses?: readonly RecoveryCause[];
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
  // Camera/model requests of the current observation, for the recovery drain check.
  const observationRequests = new Set<Promise<unknown>>();
  const causes = new Set(deps.recoveryCauses ?? []);
  const unavailableRecovery = causes.has('model_unavailable_503');
  const staleRecovery = causes.has('model_result_stale');
  let recoveryCause: RecoveryCause | undefined;
  let recoveryAttempts = 0,
    dwellResets = 0,
    resetFloor = -Infinity;
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
    // The summary follows the controller's segments: a reset ends the current segment and
    // no later evidence may bridge it, so reported dwell is never continuous across it.
    if (row.event === 'dwell_reset') {
      dwellResets++;
      if (typeof row.failed_capture_ts === 'number')
        resetFloor = Math.max(resetFloor, row.failed_capture_ts, lastCapture ?? -Infinity);
      firstCapture = undefined;
      lastCapture = undefined;
    }
    // Only the controller's accepted evidence counts, never an observer-returned frame
    // subsequently rejected for predating arming, a capture gap or duplicate identity.
    if (row.event === 'evidence' && typeof row.capture_ts === 'number') {
      observations++;
      const age = now() - row.capture_ts;
      if (age < 0 || age >= 6000 || row.capture_ts <= resetFloor) safetyViolation = true;
      if (row.verdict === 'person') {
        if (lastCapture !== undefined && row.capture_ts - lastCapture >= 6000)
          safetyViolation = true;
        firstCapture ??= row.capture_ts;
        lastCapture = row.capture_ts;
        maxDwell = Math.max(maxDwell, lastCapture - firstCapture);
      }
    }
  };
  const segmentDwell = () =>
    firstCapture === undefined || lastCapture === undefined ? 0 : lastCapture - firstCapture;
  const track = async <T>(
    operation: () => Promise<T>,
    requestSignal: AbortSignal,
    group?: Set<Promise<unknown>>,
  ) => {
    requestSignal.throwIfAborted();
    const request = Promise.resolve().then(operation);
    pending.add(request);
    group?.add(request);
    void request.then(
      () => {
        pending.delete(request);
        group?.delete(request);
      },
      () => {
        pending.delete(request);
        group?.delete(request);
      },
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
          dwell_ms: segmentDwell(),
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
          dwell_ms: segmentDwell(),
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
    followUpLookbackMs: boundedYardLimits.followUpLookbackMs,
    settleModelFailures: unavailableRecovery,
    // Private run journal only, so an uncertain or disagreeing frame can be explained.
    recordJudgementReasons: true,
    // Only an unspent recovery in a started segment may turn a late result into a break.
    breakOnStaleResult: () =>
      staleRecovery &&
      recoveryAttempts < boundedYardLimits.recoveries &&
      monitor.current()?.status().encounterStarted === true,
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
        observationRequests,
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
    converse: async (content, onResponse, observationSignal) => {
      if (modelCalls >= boundedYardLimits.modelCalls) throw new Error('qualification_model_cap');
      signal.throwIfAborted();
      modelCalls++;
      const timed = timedSignal(boundedYardLimits.modelTimeoutMs);
      const requestSignal = observationSignal ? AbortSignal.any([timed, observationSignal]) : timed;
      return track(
        () => deps.converse(content, requestSignal, onResponse),
        requestSignal,
        observationRequests,
      );
    },
  });
  // Returns true only when the failed observation is fully drained and the SAME encounter
  // has restarted dwell; the caller then waits for a strictly newer frame. Anything else
  // leaves the original failure to end the run exactly as before.
  const recover = async (
    encounter: NonNullable<ReturnType<typeof monitor.current>>,
    error: unknown,
  ) => {
    if (
      !(error instanceof ModelUnavailableBreak || error instanceof StaleResultBreak) ||
      !causes.has(error.reason) ||
      recoveryAttempts >= boundedYardLimits.recoveries ||
      // A late result before any dwell exists must never spend the recovery.
      (error instanceof StaleResultBreak && encounter.status().encounterStarted !== true)
    )
      return false;
    recoveryAttempts++;
    recoveryCause = error.reason;
    audit({
      event: 'qualification_recovery_started',
      reason: error.reason,
      failed_capture_ts: error.captureTs,
    });
    const refuse = (reason: string) => {
      audit({ event: 'qualification_recovery_refused', reason });
      return false;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled([...observationRequests]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedYardLimits.recoveryDrainMs);
      }),
    ]);
    clearTimeout(timer);
    if (!drained || observationRequests.size > 0) return refuse('observation_not_drained');
    if (
      signal.aborted ||
      monitor.current() !== encounter ||
      encounter.status().state !== 'armed' ||
      !deps.authorized() ||
      deps.killed()
    )
      return refuse('encounter_not_armed_or_authority_lost');
    if (!(await encounter.restartDwell(error.captureTs, error.reason)))
      return refuse('dwell_not_restartable');
    audit({ event: 'qualification_recovered', reason: error.reason });
    return true;
  };
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
        let frame: TestEvidence | undefined;
        try {
          frame = await pollEncounterObservation(current, () => observer.poll(), audit);
        } catch (error) {
          // A late result stays a silent drop when not recovered; only a 503 becomes a fault.
          if (!(await recover(current, error)) && !(error instanceof StaleResultBreak)) throw error;
        }
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
    // Longest single continuous segment; segments separated by a reset are never summed.
    max_dwell_ms: maxDwell,
    model_unavailable_recovery: unavailableRecovery ? 'enabled' : 'disabled',
    stale_result_recovery: staleRecovery ? 'enabled' : 'disabled',
    recovery_attempts: recoveryAttempts,
    recovery_cause: recoveryCause,
    dwell_resets: dwellResets,
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
