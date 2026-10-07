// Coordinator (plan v7 section 7): one active incident, write-ahead intents, serialized
// dispatch through the allowlist, stand-down and cleanup, reconcile, boot sweep, and the
// wildlife/intruder preemption. Both profiles share it.
//
// Order of guards on every ESCALATION call (on, open, play, set):
//   allowlist -> kill switch -> reconcile inhibition -> incident still active at the same
//   version -> evidence is the zone's newest and under 15 s old -> rate cap (audio)
//   -> write-ahead intent -> adapter call with a 3 s deadline.
// SAFETY calls (off, close, stop) skip everything after the allowlist, so cleanup always runs.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { actuatorFor, type Actuators } from './actuators.ts';
import { checkAction, CLEANUP_SERVICE, domainOf, type Allowlist } from './allowlist.ts';
import {
  activeIncident,
  closeIncident,
  completeIntent,
  convertPendingIntents,
  openIncident,
  openReconcile,
  openReconcileEntities,
  recordIntent,
  type IncidentRow,
  type Profile,
} from './db.ts';
import type { DecisionKind } from './db.ts';
import {
  intruderPlan,
  step as ladderStep,
  VALVE_CHECK_AFTER_MS,
  wildlifePlan,
  type ActuatorConfig,
  type FrameEval,
  type LadderState,
  type Mode,
  type Step,
} from './ladder.ts';

export const CALL_DEADLINE_MS = 3000;
export const INFLIGHT_WAIT_MS = 3000;
export const CLEANUP_BUDGET_MS = 15_000;
export const CLEANUP_TRIES = 3;
export const MAX_EVIDENCE_AGE_MS = 15_000;
export const AUDIO_CAP = { plays: 3, windowMs: 60_000 };
export const RECONCILE_FIRST_MS = 30_000;
export const RECONCILE_MAX_MS = 5 * 60_000;

export interface CoordinatorConfig {
  actuators: ActuatorConfig;
  mode: Mode;
  // Highest intruder level allowed. Plan v7 gates: follow-up frames unverified -> 1.
  maxIntruderLevel: number;
  cooldownMs: number;
  ownerUserIds: string[];
}

export interface CoordClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const defaultClock: CoordClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
};

// What the pipeline hands over for each decided event.
export interface Evaluation {
  zone: string;
  kind: DecisionKind;
  reason: string;
  species?: string;
  evidenceId?: string;
  captureTs?: number;
  frame?: Buffer;
}

export interface CoordinatorDeps {
  db: DatabaseSync;
  allowlist: Allowlist;
  actuators: Actuators;
  killed: () => boolean;
  log: (rec: { event: string; [k: string]: unknown }) => void;
  stopUrl: (incidentId: number) => string;
  clock?: CoordClock;
}

interface Ctx {
  incidentId: number;
  version: number;
  zone: string;
  evidenceId?: string;
  frame?: Buffer;
}

type CallOutcome = { ok: boolean; reason?: string };

const EXPECTED_AFTER_CLEANUP: Record<string, string[]> = {
  light: ['off'],
  switch: ['off'],
  valve: ['closed'],
  pi_audio: ['idle'],
  media_player: ['idle', 'off', 'paused', 'standby'],
};

// Map one pipeline decision onto a ladder frame for an open intruder incident.
export function classify(ev: Evaluation): FrameEval | undefined {
  const t = ev.captureTs;
  if (ev.kind === 'killed' || ev.reason === 'camera_busy') return undefined;
  if (ev.kind === 'reject' || ev.kind === 'no_evidence' || t === undefined) {
    return { kind: 'bad', reason: `${ev.kind}:${ev.reason}` };
  }
  if (ev.kind === 'intruder') return { kind: 'person', captureTs: t };
  if (ev.kind === 'wildlife') return { kind: 'no_person', captureTs: t };
  if (ev.reason === 'benign') return { kind: 'benign', captureTs: t };
  if (/^person_(unknown|suspicious)_daytime_home$/.test(ev.reason)) {
    return { kind: 'person', captureTs: t };
  }
  if (
    ev.reason === 'nothing_actionable' ||
    ev.reason === 'outside_night_window' ||
    ev.reason.startsWith('species_with_verdict_')
  ) {
    return { kind: 'no_person', captureTs: t };
  }
  return { kind: 'bad', reason: ev.reason }; // person_uncertain, critique_uncertain, ...
}

export function createCoordinator(cfg: CoordinatorConfig, deps: CoordinatorDeps) {
  const { db, allowlist, actuators } = deps;
  const clock = deps.clock ?? defaultClock;
  const latest = new Map<string, { evidenceId: string; captureTs: number }>();
  const reverts: { at: number; entity: string; incidentId: number }[] = [];
  const valveChecks: { at: number; valve: string; incidentId: number }[] = [];
  const audioPlays: number[] = [];
  const crossZoneNotified = new Set<string>();
  let evalChain: Promise<void> = Promise.resolve();
  let actionChain: Promise<void> = Promise.resolve();
  let inFlight: Promise<unknown> | undefined;

  const log = deps.log;

  // ---- helpers ----

  function incidentById(id: number) {
    return db
      .prepare('SELECT id, status, version, zone, profile FROM incidents WHERE id = ?')
      .get(id) as
      { id: number; status: string; version: number; zone: string; profile: Profile } | undefined;
  }

  function cooldownActive(zone: string, profile: Profile): boolean {
    const r = db
      .prepare('SELECT until_ms FROM cooldowns WHERE zone = ? AND profile = ?')
      .get(zone, profile) as { until_ms: number } | undefined;
    return !!r && r.until_ms > clock.now();
  }

  function setCooldown(zone: string, profile: Profile) {
    db.prepare(
      'INSERT INTO cooldowns (zone, profile, until_ms) VALUES (?, ?, ?) ON CONFLICT (zone, profile) DO UPDATE SET until_ms = excluded.until_ms',
    ).run(zone, profile, clock.now() + cfg.cooldownMs);
  }

  function saveLadder(id: number, s: LadderState, evidenceId?: string) {
    db.prepare(
      'UPDATE incidents SET level = ?, dwell_start_ms = ?, last_frame_ms = ?, no_person_count = ?, bad_evidence_count = ?, last_evidence_id = COALESCE(?, last_evidence_id) WHERE id = ?',
    ).run(
      s.level,
      s.dwellStartMs,
      s.lastFrameMs,
      s.noPersonCount,
      s.badEvidenceCount,
      evidenceId ?? null,
      id,
    );
  }

  function ladderOf(inc: IncidentRow): LadderState {
    return {
      level: inc.level,
      openedAt: inc.opened_at,
      dwellStartMs: inc.dwell_start_ms,
      lastFrameMs: inc.last_frame_ms,
      noPersonCount: inc.no_person_count,
      badEvidenceCount: inc.bad_evidence_count,
    };
  }

  // Entities whose escalation is blocked: an open reconcile row on the entity or, for a setter,
  // on the entity it cleans up through.
  function inhibited(entity: string): boolean {
    const open = openReconcileEntities(db);
    const via = allowlist.entities.get(entity)?.cleanup_via;
    return open.has(entity) || (via !== undefined && open.has(via));
  }

  async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timedOut = false;
    const timer = clock.sleep(ms).then(() => {
      timedOut = true;
      return 'timeout' as const;
    });
    const r = await Promise.race([p, timer]);
    return timedOut ? 'timeout' : (r as T);
  }

  // ---- the one path to an actuator ----

  async function dispatch(
    entity_id: string,
    service: string,
    data: Record<string, unknown> | undefined,
    ctx: Ctx | null, // null: safety command outside an incident (boot sweep, reconcile, revert)
  ): Promise<CallOutcome> {
    const check = checkAction(allowlist, { entity_id, service, data });
    if (!check.ok) {
      log({ event: 'call_rejected', entity_id, service, reason: check.reason });
      return { ok: false, reason: check.reason };
    }
    if (check.cls === 'escalation') {
      const refuse = (reason: string) => {
        log({
          event: 'escalation_refused',
          entity_id,
          service,
          reason,
          incident_id: ctx?.incidentId,
        });
        return { ok: false, reason };
      };
      if (!ctx) return refuse('no_incident');
      if (deps.killed()) return refuse('kill_switch');
      if (inhibited(entity_id)) return refuse('reconcile_inhibited');
      const inc = incidentById(ctx.incidentId);
      if (!inc || inc.status !== 'active' || inc.version !== ctx.version) {
        return refuse('incident_changed');
      }
      const newest = latest.get(ctx.zone);
      if (
        !ctx.evidenceId ||
        newest?.evidenceId !== ctx.evidenceId ||
        clock.now() - newest.captureTs >= MAX_EVIDENCE_AGE_MS
      ) {
        return refuse('stale_evidence');
      }
      if (domainOf(entity_id) === 'pi_audio' && service === 'play_clip') {
        const since = clock.now() - AUDIO_CAP.windowMs;
        while (audioPlays.length && audioPlays[0] < since) audioPlays.shift();
        if (audioPlays.length >= AUDIO_CAP.plays) return refuse('audio_rate_cap');
        audioPlays.push(clock.now());
      }
    }
    const intentId = randomUUID();
    const dispatchEpochMs = clock.now();
    recordIntent(
      db,
      {
        intentId,
        incidentId: ctx?.incidentId ?? null,
        entityId: entity_id,
        service,
        data,
        cls: check.cls,
        evidenceId: ctx?.evidenceId,
      },
      dispatchEpochMs,
    );
    const call = actuatorFor(actuators, entity_id).call({
      intentId,
      entity_id,
      service,
      data,
      dispatchEpochMs,
    });
    inFlight = call;
    const res = await withDeadline(call, CALL_DEADLINE_MS);
    if (inFlight === call) inFlight = undefined;
    if (res === 'timeout' || (!res.ok && res.error === 'timeout')) {
      completeIntent(db, intentId, 'unknown', 'timeout', undefined, clock.now());
      openReconcile(
        db,
        {
          entityId: entity_id,
          incidentId: ctx?.incidentId ?? null,
          intentId,
          action: service,
          reason: 'call_timeout',
        },
        clock.now(),
      );
      log({ event: 'call_unknown', entity_id, service, intent_id: intentId });
      return { ok: false, reason: 'timeout' };
    }
    if (!res.ok) {
      completeIntent(db, intentId, 'failed', res.error, undefined, clock.now());
      log({ event: 'call_failed', entity_id, service, intent_id: intentId, error: res.error });
      return { ok: false, reason: res.error };
    }
    completeIntent(
      db,
      intentId,
      actuators.live ? 'done' : 'dry_run',
      actuators.live ? 'ok' : 'would_call',
      res.contextId,
      clock.now(),
    );
    log({
      event: actuators.live ? 'call_done' : 'would_call',
      entity_id,
      service,
      data,
      cls: check.cls,
      intent_id: intentId,
      incident_id: ctx?.incidentId,
    });
    return { ok: true };
  }

  // Safety command with read-back, retried; a failure leaves a reconcile row.
  async function safeOff(entity: string, incidentId: number | null): Promise<boolean> {
    const target = allowlist.entities.get(entity)?.cleanup_via ?? entity;
    const domain = domainOf(target);
    const service = CLEANUP_SERVICE[domain];
    if (!service) {
      log({ event: 'cleanup_no_service', entity_id: target });
      return false;
    }
    const act = actuatorFor(actuators, target);
    for (let i = 0; i < CLEANUP_TRIES; i++) {
      await dispatch(target, service, undefined, null);
      const state = await withDeadline(act.readState(target), CALL_DEADLINE_MS);
      if (
        state !== 'timeout' &&
        state !== undefined &&
        EXPECTED_AFTER_CLEANUP[domain]?.includes(state)
      ) {
        return true;
      }
    }
    openReconcile(
      db,
      { entityId: target, incidentId, action: service, reason: 'cleanup_read_back_failed' },
      clock.now(),
    );
    log({ event: 'cleanup_failed', entity_id: target, incident_id: incidentId });
    return false;
  }

  function touchedEntities(incidentId: number): string[] {
    const rows = db
      .prepare(
        "SELECT DISTINCT entity_id FROM action_intents WHERE incident_id = ? AND cls = 'escalation'",
      )
      .all(incidentId) as { entity_id: string }[];
    const targets = new Set(
      rows.map((r) => allowlist.entities.get(r.entity_id)?.cleanup_via ?? r.entity_id),
    );
    return [...targets];
  }

  async function cleanup(incidentId: number, entities: string[]): Promise<void> {
    const t0 = clock.now();
    for (const e of entities) await safeOff(e, incidentId);
    const ms = clock.now() - t0;
    log({ event: 'cleanup_done', incident_id: incidentId, entities, ms });
    if (ms > CLEANUP_BUDGET_MS) {
      await notify(incidentId, `Cleanup took ${Math.round(ms / 1000)} s. Check the yard.`);
    }
  }

  async function notify(incidentId: number, text: string, frame?: Buffer) {
    try {
      await actuators.notifier.send({ incidentId, text, frame, stopUrl: deps.stopUrl(incidentId) });
    } catch (e) {
      log({ event: 'notify_failed', incident_id: incidentId, error: (e as Error).message });
    }
  }

  // ---- step execution (inside the action chain) ----

  async function runStep(s: Step, ctx: Ctx): Promise<void> {
    if (s.kind === 'notify') {
      const inc = incidentById(ctx.incidentId);
      if (!inc || inc.status !== 'active' || inc.version !== ctx.version) return;
      return notify(ctx.incidentId, s.text, ctx.frame);
    }
    if (s.kind === 'call') {
      const r = await dispatch(s.entity_id, s.service, s.data, ctx);
      if (r.ok && s.revertAfterMs) {
        reverts.push({
          at: clock.now() + s.revertAfterMs,
          entity: s.entity_id,
          incidentId: ctx.incidentId,
        });
      }
      return;
    }
    // valve_run: the duration must read back as the requested seconds before the valve opens.
    const set = await dispatch(s.setter, 'set_value', { value: s.seconds }, ctx);
    if (!set.ok) return;
    const rb = await withDeadline(
      actuatorFor(actuators, s.setter).readState(s.setter),
      CALL_DEADLINE_MS,
    );
    if (rb === 'timeout' || Number(rb) !== s.seconds) {
      log({
        event: 'valve_blocked',
        reason: 'duration_read_back_mismatch',
        read: rb,
        incident_id: ctx.incidentId,
      });
      await notify(ctx.incidentId, `Valve not opened: duration read back as ${String(rb)}.`);
      return;
    }
    const open = await dispatch(s.valve, 'open_valve', undefined, ctx);
    if (open.ok) {
      valveChecks.push({
        at: clock.now() + VALVE_CHECK_AFTER_MS,
        valve: s.valve,
        incidentId: ctx.incidentId,
      });
    }
  }

  function enqueue(steps: Step[], ctx: Ctx) {
    actionChain = actionChain.then(async () => {
      for (const s of steps) {
        const inc = incidentById(ctx.incidentId);
        if (!inc || inc.status !== 'active' || inc.version !== ctx.version) {
          log({ event: 'queue_dropped', incident_id: ctx.incidentId, remaining: steps.length });
          return;
        }
        await runStep(s, ctx);
      }
    });
    return actionChain;
  }

  // ---- incident lifecycle ----

  async function endIncident(
    id: number,
    status: 'cancelled' | 'exited',
    reason: string,
    opts: { cleanupEntities?: boolean } = {},
  ): Promise<void> {
    const inc = incidentById(id);
    if (!inc || inc.status !== 'active') return;
    closeIncident(db, id, status, reason, clock.now()); // version bump: queued steps abort
    setCooldown(inc.zone, inc.profile);
    log({ event: 'incident_closed', incident_id: id, status, reason, profile: inc.profile });
    if (opts.cleanupEntities === false) return;
    for (let i = reverts.length - 1; i >= 0; i--)
      if (reverts[i].incidentId === id) reverts.splice(i, 1);
    if (inFlight) await withDeadline(inFlight, INFLIGHT_WAIT_MS);
    await cleanup(id, touchedEntities(id));
  }

  function openWithLadder(zone: string, ev: Evaluation): Promise<void> | undefined {
    const id = openIncident(db, zone, 'intruder', clock.now());
    if (id === null) return undefined;
    log({ event: 'incident_opened', incident_id: id, profile: 'intruder', zone });
    return advance(activeIncident(db)!, ev);
  }

  async function advance(inc: IncidentRow, ev: Evaluation): Promise<void> {
    const frame = classify(ev);
    if (!frame) return;
    const r = ladderStep(ladderOf(inc), frame, {
      now: clock.now(),
      mode: cfg.mode,
      maxLevel: cfg.maxIntruderLevel,
    });
    saveLadder(inc.id, r.state, ev.evidenceId);
    if (r.exit) return endIncident(inc.id, 'exited', r.exit);
    const ctx: Ctx = {
      incidentId: inc.id,
      version: inc.version,
      zone: inc.zone,
      evidenceId: ev.evidenceId,
      frame: ev.frame,
    };
    for (const level of r.enter) {
      const plan = intruderPlan(level, inc.zone, cfg.actuators);
      log({ event: 'level_entered', incident_id: inc.id, level, skipped: plan.skipped });
      void enqueue(plan.steps, ctx);
    }
  }

  async function startWildlife(ev: Evaluation): Promise<void> {
    const id = openIncident(db, ev.zone, 'wildlife', clock.now());
    if (id === null) return onEvaluationInner(ev); // lost a race: route again
    const plan = wildlifePlan(ev.zone, ev.species ?? 'wildlife', cfg.actuators);
    log({
      event: 'incident_opened',
      incident_id: id,
      profile: 'wildlife',
      zone: ev.zone,
      skipped: plan.skipped,
    });
    const inc = incidentById(id)!;
    void enqueue(plan.steps, {
      incidentId: id,
      version: inc.version,
      zone: ev.zone,
      evidenceId: ev.evidenceId,
      frame: ev.frame,
    });
  }

  // Same-zone person during a wildlife run: in ONE transaction the wildlife incident is
  // cancelled and the intruder incident inserted, so the one-active index holds throughout.
  async function preempt(wild: IncidentRow, ev: Evaluation): Promise<void> {
    if (cooldownActive(ev.zone, 'intruder')) {
      log({ event: 'preempt_skipped', reason: 'intruder_cooldown', incident_id: wild.id });
      return;
    }
    const wildEntities = touchedEntities(wild.id);
    let newId: number;
    db.exec('BEGIN IMMEDIATE');
    try {
      closeIncident(db, wild.id, 'cancelled', 'preempted', clock.now());
      newId = openIncident(db, ev.zone, 'intruder', clock.now())!;
      if (newId === null) throw new Error('one_active_incident violated during preemption');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    setCooldown(wild.zone, 'wildlife');
    for (let i = valveChecks.length - 1; i >= 0; i--)
      if (valveChecks[i].incidentId === wild.id) valveChecks.splice(i, 1);
    log({ event: 'preempted', wildlife_incident: wild.id, intruder_incident: newId });
    if (inFlight) await withDeadline(inFlight, INFLIGHT_WAIT_MS);
    await cleanup(wild.id, wildEntities); // failures leave reconcile rows; the ladder goes on
    await advance(activeIncident(db)!, ev);
  }

  async function onEvaluationInner(ev: Evaluation): Promise<void> {
    if (ev.kind === 'killed' || ev.reason === 'camera_busy') return;
    if (ev.evidenceId && ev.captureTs !== undefined) {
      const prev = latest.get(ev.zone);
      if (!prev || ev.captureTs >= prev.captureTs) {
        latest.set(ev.zone, { evidenceId: ev.evidenceId, captureTs: ev.captureTs });
      }
    }
    const inc = activeIncident(db);
    if (inc) {
      if (inc.zone !== ev.zone) {
        if (ev.kind === 'intruder' || ev.kind === 'wildlife') {
          log({ event: 'cross_zone', incident_id: inc.id, zone: ev.zone, kind: ev.kind });
          const key = `${inc.id}:${ev.zone}`;
          if (!crossZoneNotified.has(key)) {
            crossZoneNotified.add(key);
            await notify(inc.id, `Also: ${ev.kind} in ${ev.zone} (not acted on).`, ev.frame);
          }
        }
        return;
      }
      if (inc.profile === 'wildlife') {
        if (ev.kind === 'intruder') return preempt(inc, ev);
        log({ event: 'during_wildlife', incident_id: inc.id, kind: ev.kind, reason: ev.reason });
        return;
      }
      if (ev.kind === 'wildlife') log({ event: 'wildlife_during_intruder', incident_id: inc.id });
      return advance(inc, ev);
    }
    if (ev.kind === 'intruder') {
      if (deps.killed()) return log({ event: 'not_opened', reason: 'kill_switch', zone: ev.zone });
      if (cooldownActive(ev.zone, 'intruder')) {
        return log({ event: 'not_opened', reason: 'intruder_cooldown', zone: ev.zone });
      }
      const p = openWithLadder(ev.zone, ev);
      return p ?? onEvaluationInner(ev);
    }
    if (ev.kind === 'wildlife') {
      if (deps.killed()) return log({ event: 'not_opened', reason: 'kill_switch', zone: ev.zone });
      if (cooldownActive(ev.zone, 'wildlife')) {
        return log({ event: 'not_opened', reason: 'wildlife_cooldown', zone: ev.zone });
      }
      return startWildlife(ev);
    }
  }

  // ---- public ----

  async function boot(): Promise<{ converted: number; closed: number }> {
    const converted = convertPendingIntents(db, clock.now());
    let closed = 0;
    const inc = activeIncident(db);
    if (inc) {
      closeIncident(db, inc.id, 'exited', 'restart', clock.now());
      closed = 1;
    }
    const exterior = [...allowlist.entities.values()]
      .filter((r) => r.placement === 'exterior')
      .map((r) => r.cleanup_via ?? r.entity_id);
    for (const e of new Set(exterior)) await safeOff(e, null);
    log({ event: 'boot', converted, closed, swept: [...new Set(exterior)] });
    return { converted, closed };
  }

  function onEvaluation(ev: Evaluation): Promise<void> {
    const run = evalChain.then(() => onEvaluationInner(ev));
    evalChain = run.catch((e) => log({ event: 'evaluation_failed', error: (e as Error).message }));
    return run;
  }

  async function standDown(incidentId: number, by: string): Promise<'stopped' | 'not_active'> {
    const inc = incidentById(incidentId);
    if (!inc || inc.status !== 'active') return 'not_active';
    await endIncident(incidentId, 'cancelled', `stand_down:${by}`);
    return 'stopped';
  }

  async function tick(): Promise<void> {
    const now = clock.now();
    for (let i = reverts.length - 1; i >= 0; i--) {
      if (reverts[i].at <= now) {
        const [r] = reverts.splice(i, 1);
        await safeOff(r.entity, r.incidentId);
      }
    }
    for (let i = valveChecks.length - 1; i >= 0; i--) {
      if (valveChecks[i].at > now) continue;
      const [c] = valveChecks.splice(i, 1);
      const state = await withDeadline(
        actuatorFor(actuators, c.valve).readState(c.valve),
        CALL_DEADLINE_MS,
      );
      if (state === 'closed') {
        log({ event: 'valve_closed_on_its_own', valve: c.valve, incident_id: c.incidentId });
      } else {
        log({ event: 'valve_still_open', valve: c.valve, state, incident_id: c.incidentId });
        openReconcile(
          db,
          {
            entityId: c.valve,
            incidentId: c.incidentId,
            action: 'open_valve',
            reason: 'valve_open_after_40s',
          },
          now,
        );
        await notify(c.incidentId, `Valve ${c.valve} still ${String(state)} 40 s after opening.`);
      }
      const inc = incidentById(c.incidentId);
      // The wildlife run is over once the valve is checked; lights keep their own revert.
      if (inc?.status === 'active' && inc.profile === 'wildlife') {
        await endIncident(c.incidentId, 'exited', 'completed', { cleanupEntities: false });
      }
    }
    const inc = activeIncident(db);
    if (inc && now - inc.opened_at >= 5 * 60_000) await endIncident(inc.id, 'exited', 'timeout');
    await checkReconcile(now);
  }

  async function checkReconcile(now: number): Promise<void> {
    const due = db
      .prepare(
        'SELECT id, entity_id, incident_id, ha_context_id, check_count FROM reconcile WHERE resolved_at IS NULL AND (next_check_ms IS NULL OR next_check_ms <= ?)',
      )
      .all(now) as {
      id: number;
      entity_id: string;
      incident_id: number | null;
      ha_context_id: string | null;
      check_count: number;
    }[];
    for (const r of due) {
      const domain = domainOf(r.entity_id);
      const service = CLEANUP_SERVICE[domain];
      if (service) await dispatch(r.entity_id, service, undefined, null);
      const state = await withDeadline(
        actuatorFor(actuators, r.entity_id).readState(r.entity_id),
        CALL_DEADLINE_MS,
      );
      const off =
        state !== 'timeout' &&
        state !== undefined &&
        EXPECTED_AFTER_CLEANUP[domain]?.includes(state);
      // Only a row whose context HA confirmed may resolve on its own; null-context rows wait
      // for the owner, however long they read back off (plan v7 section 7).
      if (off && r.ha_context_id) {
        db.prepare(
          "UPDATE reconcile SET resolved_at = ?, resolution = 'context_landed_then_off' WHERE id = ?",
        ).run(now, r.id);
        continue;
      }
      const backoff = Math.min(RECONCILE_FIRST_MS * 2 ** r.check_count, RECONCILE_MAX_MS);
      db.prepare(
        'UPDATE reconcile SET check_count = check_count + 1, next_check_ms = ? WHERE id = ?',
      ).run(now + backoff, r.id);
    }
  }

  function clearReconcile(rowId: number, userId: string): boolean {
    if (!cfg.ownerUserIds.includes(userId)) {
      log({ event: 'reconcile_clear_refused', row: rowId, user_id: userId });
      return false;
    }
    const r = db
      .prepare(
        "UPDATE reconcile SET resolved_at = ?, resolution = 'owner_cleared' WHERE id = ? AND resolved_at IS NULL",
      )
      .run(clock.now(), rowId);
    return r.changes > 0;
  }

  return {
    boot,
    onEvaluation,
    standDown,
    tick,
    clearReconcile,
    idle: () => Promise.all([evalChain, actionChain]).then(() => undefined),
  };
}

export type Coordinator = ReturnType<typeof createCoordinator>;

// The "coordinator" section of config/quiet-porch.json. Every entity it names must be in the
// allowlist, and interior lights must be interior, so a typo fails at load, not at 2 a.m.
export interface CoordinatorSection {
  allowlist: string;
  publicBase: string;
  maxIntruderLevel: number;
  cooldownMs: number;
  ownerUserIds: string[];
  interiorLights: string[];
  zones: ActuatorConfig['zones'];
  clips: ActuatorConfig['clips'];
}

export function parseCoordinatorSection(
  raw: unknown,
  allowlist: Allowlist,
  mode: Mode,
): CoordinatorConfig & { publicBase: string } {
  const c = raw as Partial<CoordinatorSection> | null;
  if (!c || typeof c !== 'object') throw new Error('coordinator config: not an object');
  if (typeof c.publicBase !== 'string' || !/^https:\/\//.test(c.publicBase)) {
    throw new Error('coordinator config: publicBase must be an https URL');
  }
  if (!Number.isInteger(c.maxIntruderLevel) || c.maxIntruderLevel! < 0 || c.maxIntruderLevel! > 4) {
    throw new Error('coordinator config: maxIntruderLevel must be 0..4');
  }
  if (!Number.isFinite(c.cooldownMs) || c.cooldownMs! < 0) {
    throw new Error('coordinator config: cooldownMs missing');
  }
  if (!Array.isArray(c.ownerUserIds) || c.ownerUserIds.includes('quiet-porch')) {
    throw new Error('coordinator config: ownerUserIds must be an array without the app user');
  }
  const known = (id: string, where: string) => {
    if (!allowlist.entities.has(id))
      throw new Error(`coordinator config: ${where} ${id} not in allowlist`);
    return allowlist.entities.get(id)!;
  };
  for (const id of c.interiorLights ?? []) {
    if (known(id, 'interiorLights').placement !== 'interior') {
      throw new Error(`coordinator config: ${id} is not interior`);
    }
  }
  for (const [zone, z] of Object.entries(c.zones ?? {})) {
    for (const [k, id] of Object.entries(z)) if (id) known(id, `zones.${zone}.${k}`);
    if (z.durationSetter && allowlist.entities.get(z.durationSetter)?.cleanup_via !== z.valve) {
      throw new Error(
        `coordinator config: zones.${zone} durationSetter must clean up via its valve`,
      );
    }
  }
  if (!c.clips?.bark || !c.clips?.wildlife) throw new Error('coordinator config: clips missing');
  return {
    actuators: { interiorLights: c.interiorLights ?? [], zones: c.zones ?? {}, clips: c.clips },
    mode,
    maxIntruderLevel: c.maxIntruderLevel!,
    cooldownMs: c.cooldownMs!,
    ownerUserIds: c.ownerUserIds,
    publicBase: c.publicBase.replace(/\/$/, ''),
  };
}
