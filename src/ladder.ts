// Intruder ladder and wildlife action plans (plan v7 sections 5 and 6), pure and deterministic.
// The coordinator owns time, persistence and dispatch; this module only answers "given this
// incident state and this frame, what level are we at and what should happen".

export type Mode = 'home' | 'away' | 'night';

export const DWELL_GAP_MS = 10_000; // a gap over this between valid frames resets dwell
export const GLOBAL_TIMEOUT_MS = 5 * 60_000;
export const BAD_EVIDENCE_EXIT = 3;
export const DEPARTURE_FRAMES = 2;
export const LEVEL_DWELL_MS = [0, 0, 20_000, 40_000, 60_000]; // index = level

export interface LadderState {
  level: number;
  openedAt: number;
  dwellStartMs: number | null;
  lastFrameMs: number | null;
  noPersonCount: number;
  badEvidenceCount: number;
}

// One evaluated frame, already classified by the coordinator from the pipeline decision.
export type FrameEval =
  | { kind: 'bad'; reason: string } // missing, stale, malformed, uncertain: holds the level
  | { kind: 'person'; captureTs: number } // unknown or suspicious person
  | { kind: 'benign'; captureTs: number } // reclassified benign: exit
  | { kind: 'no_person'; captureTs: number };

export type ExitReason = 'departure' | 'benign_reclassification' | 'bad_evidence' | 'timeout';

export interface LadderStep {
  state: LadderState;
  enter: number[]; // levels newly entered by this frame, ascending
  exit?: ExitReason;
}

export function newLadder(openedAt: number): LadderState {
  return {
    level: 0,
    openedAt,
    dwellStartMs: null,
    lastFrameMs: null,
    noPersonCount: 0,
    badEvidenceCount: 0,
  };
}

// Highest level the dwell earns, before the configured cap. L4 also needs mode away or night.
export function earnedLevel(dwellMs: number, mode: Mode): number {
  let level = 1;
  for (let l = 2; l <= 4; l++) if (dwellMs >= LEVEL_DWELL_MS[l]) level = l;
  if (level === 4 && mode === 'home') level = 3;
  return level;
}

export function step(
  s: LadderState,
  f: FrameEval,
  opts: { now: number; mode: Mode; maxLevel: number },
): LadderStep {
  if (opts.now - s.openedAt >= GLOBAL_TIMEOUT_MS) return { state: s, enter: [], exit: 'timeout' };
  if (f.kind === 'bad') {
    const state = { ...s, badEvidenceCount: s.badEvidenceCount + 1 };
    return state.badEvidenceCount >= BAD_EVIDENCE_EXIT
      ? { state, enter: [], exit: 'bad_evidence' }
      : { state, enter: [] };
  }
  // Frames older than the last accepted one are late results: ignore them entirely.
  if (s.lastFrameMs !== null && f.captureTs <= s.lastFrameMs) return { state: s, enter: [] };
  if (f.kind === 'benign') {
    return {
      state: { ...s, lastFrameMs: f.captureTs },
      enter: [],
      exit: 'benign_reclassification',
    };
  }
  if (f.kind === 'no_person') {
    const state = {
      ...s,
      dwellStartMs: null,
      lastFrameMs: f.captureTs,
      noPersonCount: s.noPersonCount + 1,
      badEvidenceCount: 0,
    };
    return state.noPersonCount >= DEPARTURE_FRAMES
      ? { state, enter: [], exit: 'departure' }
      : { state, enter: [] };
  }
  const gap = s.lastFrameMs === null ? Infinity : f.captureTs - s.lastFrameMs;
  const dwellStartMs = s.dwellStartMs === null || gap > DWELL_GAP_MS ? f.captureTs : s.dwellStartMs;
  const target = Math.min(earnedLevel(f.captureTs - dwellStartMs, opts.mode), opts.maxLevel);
  const enter: number[] = [];
  for (let l = s.level + 1; l <= target; l++) enter.push(l);
  return {
    state: {
      ...s,
      level: Math.max(s.level, target),
      dwellStartMs,
      lastFrameMs: f.captureTs,
      noPersonCount: 0,
      badEvidenceCount: 0,
    },
    enter,
  };
}

// ---- action plans ----

export interface ZoneActuators {
  exteriorLight?: string;
  valve?: string;
  durationSetter?: string;
  speaker?: string;
}

export interface ActuatorConfig {
  interiorLights: string[];
  zones: Record<string, ZoneActuators>;
  clips: { bark: string; wildlife: string };
}

export const VALVE_SECONDS = 30;
export const VALVE_CHECK_AFTER_MS = 40_000;
export const REVERT_MS = {
  intruderInteriorLights: 15 * 60_000,
  exteriorLight: 10 * 60_000,
  wildlifeInteriorLights: 5 * 60_000,
};

export type Step =
  | {
      kind: 'call';
      entity_id: string;
      service: string;
      data?: Record<string, unknown>;
      revertAfterMs?: number;
    }
  | { kind: 'valve_run'; setter: string; valve: string; seconds: number }
  | { kind: 'notify'; text: string };

export interface Plan {
  steps: Step[];
  skipped: string[]; // actions the plan wanted but the config has no actuator for
}

function lightsOn(cfg: ActuatorConfig, revertAfterMs: number): Step[] {
  return cfg.interiorLights.map((entity_id) => ({
    kind: 'call',
    entity_id,
    service: 'turn_on',
    revertAfterMs,
  }));
}

function valveRun(z: ZoneActuators | undefined, skipped: string[]): Step[] {
  if (!z?.valve || !z.durationSetter) {
    skipped.push('valve_run');
    return [];
  }
  return [{ kind: 'valve_run', setter: z.durationSetter, valve: z.valve, seconds: VALVE_SECONDS }];
}

export function intruderPlan(level: number, zone: string, cfg: ActuatorConfig): Plan {
  const z = cfg.zones[zone];
  const skipped: string[] = [];
  const steps: Step[] = [];
  if (level === 1) {
    steps.push({ kind: 'notify', text: `Unknown person in ${zone} (L1).` });
    if (cfg.interiorLights.length === 0) skipped.push('interior_lights');
    steps.push(...lightsOn(cfg, REVERT_MS.intruderInteriorLights));
  } else if (level === 2) {
    if (z?.exteriorLight) {
      steps.push({
        kind: 'call',
        entity_id: z.exteriorLight,
        service: 'turn_on',
        revertAfterMs: REVERT_MS.exteriorLight,
      });
    } else skipped.push('exterior_light');
  } else if (level === 3) {
    if (z?.speaker) {
      steps.push({
        kind: 'call',
        entity_id: z.speaker,
        service: 'play_clip',
        data: { clip: cfg.clips.bark },
      });
    } else skipped.push('speaker');
  } else if (level === 4) {
    steps.push(...valveRun(z, skipped));
  }
  if (level >= 2) steps.push({ kind: 'notify', text: `Intruder in ${zone} reached L${level}.` });
  return { steps, skipped };
}

// Valve first: it is the deliverable, and its read-back gate must pass before anything else
// suggests the run happened.
export function wildlifePlan(zone: string, species: string, cfg: ActuatorConfig): Plan {
  const z = cfg.zones[zone];
  const skipped: string[] = [];
  const steps: Step[] = [...valveRun(z, skipped)];
  if (cfg.interiorLights.length === 0) skipped.push('interior_lights');
  steps.push(...lightsOn(cfg, REVERT_MS.wildlifeInteriorLights));
  if (z?.speaker) {
    steps.push({
      kind: 'call',
      entity_id: z.speaker,
      service: 'play_clip',
      data: { clip: cfg.clips.wildlife },
    });
  } else skipped.push('speaker');
  steps.push({ kind: 'notify', text: `${species} in ${zone}: wildlife run.` });
  return { steps, skipped };
}
