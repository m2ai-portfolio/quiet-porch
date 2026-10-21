// One approved session: bounded-yard slots in sequence, waiting passively between them.
// Every encounter runs the unchanged one-encounter engine (runBoundedYard) with its own
// limits, freshness gate, dwell gates and durable cooldown. The session adds only:
//   - a slot starts after startsAt, after the shared cooldown, and only if it can finish
//     before expiresAt;
//   - wakes are admitted only when stamped after the previous encounter ended (re-arm);
//   - it stops at the first output attempt, after maxEncounters, at the totals, at expiry,
//     on KILL, authority loss, cancellation, or any slot that is not a clean result;
//   - a heartbeat row every minute and a row per wake seen, so a silent camera is visible.
// It never restarts itself, renews authority, or starts a service.
import type { MotionWake } from './attended-source.ts';
import type { runBoundedYard } from './bounded-yard.ts';
import { sessionSlotMs } from './attended-session-policy.ts';

export type SlotResult = Awaited<ReturnType<typeof runBoundedYard>>;

export interface SlotContext {
  slot: number;
  encounter: number; // the encounter number this slot would open
  // Pass as YardRunDependencies.readWakes: shares the session cursor, logs and filters.
  readWakes: (cursor: number) => { after: number; wakes: MotionWake[] };
  // Call before each camera frame / model request; throws once the session total is spent.
  spendFrame: () => void;
  spendModelCall: () => void;
}

export interface SessionDependencies {
  startsAt: number;
  expiresAt: number;
  maxEncounters: number;
  totals: { frames: number; modelCalls: number };
  cursor: number;
  readWakes: (cursor: number) => { after: number; wakes: MotionWake[] };
  cooldownUntil: () => number; // the shared, durable cooldown, re-read before each slot
  authorized: () => boolean; // the full live authority check, window included
  killed: () => boolean;
  runSlot: (context: SlotContext) => Promise<SlotResult>;
  audit: (row: Record<string, unknown>) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const heartbeatMs = 60000;

export async function runAttendedSession(deps: SessionDependencies) {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const began = now();
  let cursor = deps.cursor,
    rearmAt = -Infinity,
    lastWakeAt: number | undefined,
    quietSince = Math.max(began, deps.startsAt),
    longestQuiet = 0,
    lastHeartbeat = -Infinity,
    wakesSeen = 0,
    slots = 0,
    encounters = 0,
    spentFrames = 0,
    spentModelCalls = 0,
    overspent = false,
    reason = 'session_expired';
  const results: SlotResult[] = [];
  const outcomes: Record<string, unknown>[] = [];

  const quiet = (at: number) => {
    if (at >= quietSince) longestQuiet = Math.max(longestQuiet, at - quietSince);
  };
  // The slot's own cursor argument is ignored: the session owns the shared cursor.
  const readWakes = () => {
    const batch = deps.readWakes(cursor);
    cursor = batch.after;
    for (const wake of batch.wakes) {
      wakesSeen++;
      quiet(wake.eventTs);
      quietSince = Math.max(quietSince, wake.eventTs);
      lastWakeAt = wake.eventTs;
      deps.audit({
        event: 'session_wake_seen',
        event_id: wake.id,
        event_ts: wake.eventTs,
        eligible: wake.eventTs > rearmAt,
      });
    }
    return { after: cursor, wakes: batch.wakes.filter((wake) => wake.eventTs > rearmAt) };
  };
  const heartbeat = (phase: string) => {
    const t = now();
    if (t - lastHeartbeat < heartbeatMs) return;
    lastHeartbeat = t;
    deps.audit({
      event: 'session_waiting',
      phase,
      since_last_wake_ms: lastWakeAt === undefined ? undefined : t - lastWakeAt,
      encounters,
    });
  };
  const spend = (kind: 'frames' | 'modelCalls') => () => {
    const spent = kind === 'frames' ? ++spentFrames : ++spentModelCalls;
    if (spent > deps.totals[kind]) {
      overspent = true;
      throw new Error(`session_${kind}_cap`);
    }
  };

  deps.audit({
    event: 'attended_session_started',
    starts_at: deps.startsAt,
    expires_at: deps.expiresAt,
    max_encounters: deps.maxEncounters,
    totals: deps.totals,
  });
  try {
    for (;;) {
      if (deps.signal?.aborted) {
        reason = 'session_cancelled';
        break;
      }
      if (deps.killed()) {
        reason = 'killed';
        break;
      }
      const t = now();
      if (t >= deps.expiresAt || deps.expiresAt - t < sessionSlotMs) {
        reason = 'session_expired';
        break;
      }
      if (t < deps.startsAt || t < deps.cooldownUntil()) {
        heartbeat(t < deps.startsAt ? 'before_start' : 'cooldown');
        readWakes();
        await sleep(1000);
        continue;
      }
      if (!deps.authorized()) {
        reason = 'authority_lost';
        break;
      }
      slots++;
      deps.audit({ event: 'session_slot_started', slot: slots, encounter: encounters + 1 });
      const result = await deps.runSlot({
        slot: slots,
        encounter: encounters + 1,
        readWakes: () => {
          heartbeat('armed');
          return readWakes();
        },
        spendFrame: spend('frames'),
        spendModelCall: spend('modelCalls'),
      });
      results.push(result);
      const clean = result.safety_pass && result.drained && result.cleanup_succeeded;
      deps.audit({
        event: 'session_slot_finished',
        slot: slots,
        reason: result.reason,
        safety_pass: result.safety_pass,
      });
      if (result.reason === 'no_encounter' && clean) continue;
      if (result.reason !== 'encounter_completed' || !clean || result.transport_result === 'fail') {
        reason = 'slot_fault';
        break;
      }
      encounters++;
      rearmAt = now();
      quietSince = Math.max(quietSince, rearmAt);
      outcomes.push({
        encounter: encounters,
        frames: result.frames,
        model_calls: result.model_calls,
        observations: result.observations,
        max_dwell_ms: result.max_dwell_ms,
        alert_attempts: result.alert_attempts,
        speech_attempts: result.speech_attempts,
        transport_result: result.transport_result,
      });
      if (result.alert_attempts > 0 || result.speech_attempts > 0) {
        reason = 'output_attempted';
        break;
      }
      if (encounters >= deps.maxEncounters) {
        reason = 'encounters_exhausted';
        break;
      }
      if (spentFrames >= deps.totals.frames || spentModelCalls >= deps.totals.modelCalls) {
        reason = 'totals_reached';
        break;
      }
    }
  } catch (error) {
    reason = 'session_fault';
    deps.audit({ event: 'session_fault', message: (error as Error)?.message });
  }
  const ended = now();
  quiet(Math.min(ended, deps.expiresAt));
  const sum = (key: keyof SlotResult) =>
    results.reduce((total, r) => total + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);
  const frames = sum('frames'),
    modelCalls = sum('model_calls'),
    alertAttempts = sum('alert_attempts'),
    speechAttempts = sum('speech_attempts'),
    alertAcks = sum('alert_acknowledgements'),
    speechAcks = sum('speech_acknowledgements');
  const drained = results.every((r) => r.drained);
  const cleanup = results.every((r) => r.cleanup_succeeded);
  const fault = reason === 'slot_fault' || reason === 'session_fault';
  const safetyPass =
    results.every((r) => r.safety_pass) &&
    !overspent &&
    drained &&
    cleanup &&
    frames <= deps.totals.frames &&
    modelCalls <= deps.totals.modelCalls &&
    encounters <= deps.maxEncounters &&
    alertAttempts <= 1 &&
    speechAttempts <= 1;
  const summary = {
    event: 'attended_session_finished',
    mode: 'attended_session',
    reason,
    safety_pass: safetyPass,
    transport_result:
      !safetyPass || fault || results.some((r) => r.transport_result === 'fail')
        ? 'fail'
        : alertAcks === 1 && speechAcks === 1
          ? 'acknowledged'
          : 'inconclusive',
    physical_delivery: 'owner_confirmation_required',
    slots,
    encounters,
    encounter_outcomes: outcomes,
    wakes_seen: wakesSeen,
    longest_quiet_ms: longestQuiet,
    frames,
    model_calls: modelCalls,
    alert_attempts: alertAttempts,
    speech_attempts: speechAttempts,
    alert_acknowledgements: alertAcks,
    speech_acknowledgements: speechAcks,
    cleanup_succeeded: cleanup,
    drained,
    elapsed_ms: ended - began,
  };
  deps.audit(summary);
  return summary;
}
