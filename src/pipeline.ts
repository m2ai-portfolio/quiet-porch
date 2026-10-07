// Decision pipeline, dry run (plan v7 build step 2):
//   webhook -> events (dedupe) -> event frame -> evidence -> perception -> critique ->
//   profile selection -> decision log.
// It has no actuator code and no path to one: the strongest outcome is a logged
// "would open intruder incident" or "would run wildlife profile".
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { imageBlock, parseModelJson, type ContentBlock } from './bedrock.ts';
import {
  critiquePrompt,
  validateCritique,
  type Critique,
  type HouseholdContext,
} from './critique.ts';
import { recordDecision, recordEvent, recordEvidence, type DecisionKind } from './db.ts';
import { decide, inWindow, needsCritique, type Decision } from './decide.ts';
import {
  acquireEventFrame,
  probeFollowUps,
  realClock,
  type Clock,
  type Download,
  type MotionEvent,
  type ProbeRecord,
} from './frames.ts';
import {
  perceptionPrompt,
  validatePerception,
  type Perception,
  type Validated,
} from './perception.ts';

export const MAX_EVIDENCE_AGE_MS = 15_000;

export interface PipelineConfig {
  timezone: string;
  nightWindow: { start: string; end: string };
  zones: Record<string, string>; // Ring device id -> zone
  context: HouseholdContext;
  dryRun: true; // step 2 has no actuators; anything else is refused at load
  followUpProbe: boolean;
}

export interface DecisionRecord {
  source_event_id: string;
  device_id: string;
  sub_type: string;
  zone: string;
  event_ts: number;
  kind: DecisionKind;
  reason: string;
  would?: string;
  evidence_id?: string;
  evidence_age_ms?: number;
  perception?: unknown;
  critique?: unknown;
  timings: {
    frame_ready_after_event_ms?: number;
    perception_ms?: number;
    critique_ms?: number;
    decided_after_event_ms: number;
  };
  dry_run: true;
}

export interface PipelineDeps {
  db: DatabaseSync;
  download: Download;
  converse: (content: ContentBlock[]) => Promise<string>;
  killed: () => boolean;
  writeProbe: (r: ProbeRecord) => void;
  writeDecision: (r: DecisionRecord) => void;
  saveFrame: (evidenceId: string, jpeg: Buffer) => void;
  clock?: Clock;
}

export function parsePipelineConfig(raw: unknown): PipelineConfig {
  const c = raw as Partial<PipelineConfig> | null;
  if (!c || typeof c !== 'object') throw new Error('pipeline config: not an object');
  if (c.dryRun !== true)
    throw new Error('pipeline config: dryRun must be true (no actuators in step 2)');
  if (typeof c.timezone !== 'string') throw new Error('pipeline config: timezone missing');
  inWindow(0, c.nightWindow?.start ?? '', c.nightWindow?.end ?? '', c.timezone); // throws on bad times
  if (!c.zones || typeof c.zones !== 'object') throw new Error('pipeline config: zones missing');
  const ctx = c.context;
  if (!ctx || !['home', 'away', 'night'].includes(ctx.mode)) {
    throw new Error('pipeline config: context.mode must be home, away or night');
  }
  for (const k of ['knownPets', 'expectedVisitors', 'routines', 'nuisanceSpecies'] as const) {
    if (!Array.isArray(ctx[k])) throw new Error(`pipeline config: context.${k} must be an array`);
  }
  return { ...c, followUpProbe: c.followUpProbe ?? true } as PipelineConfig;
}

function sha256(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

export function evidenceIdFor(
  zone: string,
  deviceId: string,
  captureTs: number,
  imageSha: string,
): string {
  return `ev_${sha256(`${zone}|ring:${deviceId}|${captureTs}|${imageSha}`).slice(0, 24)}`;
}

async function modelJson<T>(
  call: () => Promise<string>,
  validate: (raw: unknown) => Validated<T>,
): Promise<{ result: Validated<T>; ms: number; raw?: unknown }> {
  const t0 = Date.now();
  try {
    const raw = parseModelJson(await call());
    return { result: validate(raw), ms: Date.now() - t0, raw };
  } catch (e) {
    return {
      result: { ok: false, reason: `model_error: ${(e as Error).message.slice(0, 160)}` },
      ms: Date.now() - t0,
    };
  }
}

function wouldText(kind: DecisionKind, zone: string, species?: string): string | undefined {
  if (kind === 'intruder') return `would open an intruder incident in ${zone} at L1`;
  if (kind === 'wildlife') return `would run the wildlife profile in ${zone} (${species})`;
  return undefined;
}

export interface Judgement {
  decision: Decision;
  perception: unknown; // raw model JSON, or {error} when it could not be parsed
  critique?: unknown;
  perceptionMs: number;
  critiqueMs?: number;
}

// Perception -> (critique) -> decide on one accepted frame. Shared by the live pipeline and the
// fixture evaluation, so both exercise the same prompts, validation and rules.
export async function judgeFrame(
  jpeg: Buffer,
  captureTs: number,
  evidenceId: string,
  zone: string,
  cfg: Pick<PipelineConfig, 'timezone' | 'nightWindow' | 'context'>,
  converseFn: (content: ContentBlock[]) => Promise<string>,
  inNightWindowOverride?: boolean,
): Promise<Judgement> {
  const perc = await modelJson<Perception>(
    () => converseFn([imageBlock(jpeg), { text: perceptionPrompt(evidenceId) }]),
    (raw) => validatePerception(raw, evidenceId),
  );
  const species = cfg.context.nuisanceSpecies;
  let crit: { result: Validated<Critique>; ms: number; raw?: unknown } | undefined;
  if (perc.result.ok && needsCritique(perc.result.value, species)) {
    const p = perc.result.value;
    const localTime = new Intl.DateTimeFormat('en-US', {
      timeZone: cfg.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(captureTs));
    crit = await modelJson<Critique>(
      () => converseFn([{ text: critiquePrompt(p, cfg.context, zone, localTime) }]),
      (raw) => validateCritique(raw, evidenceId),
    );
  }
  const decision = decide({
    perception: perc.result,
    critique: crit?.result,
    nuisanceSpecies: species,
    inNightWindow:
      inNightWindowOverride ??
      inWindow(captureTs, cfg.nightWindow.start, cfg.nightWindow.end, cfg.timezone),
  });
  return {
    decision,
    perception: perc.raw ?? (perc.result.ok ? perc.result.value : { error: perc.result.reason }),
    ...(crit
      ? {
          critique:
            crit.raw ?? (crit.result.ok ? crit.result.value : { error: crit.result.reason }),
        }
      : {}),
    perceptionMs: perc.ms,
    critiqueMs: crit?.ms,
  };
}

export function createPipeline(cfg: PipelineConfig, deps: PipelineDeps) {
  const clock = deps.clock ?? realClock;
  const inFlight = new Set<string>();

  async function handle(ev: MotionEvent, payload: unknown): Promise<DecisionRecord | undefined> {
    const zone = cfg.zones[ev.deviceId] ?? 'unmapped';
    const fresh = recordEvent(
      deps.db,
      { source: 'ring', sourceEventId: ev.eventId, type: 'motion_detected', zone, payload },
      ev.receivedAt,
    );
    if (!fresh) return undefined; // redelivery

    const timings: DecisionRecord['timings'] = { decided_after_event_ms: 0 };
    const finish = (
      kind: DecisionKind,
      reason: string,
      extra: Partial<DecisionRecord> = {},
    ): DecisionRecord => {
      timings.decided_after_event_ms = clock.now() - ev.eventTs;
      const rec: DecisionRecord = {
        source_event_id: ev.eventId,
        device_id: ev.deviceId,
        sub_type: ev.subType,
        zone,
        event_ts: ev.eventTs,
        kind,
        reason,
        ...extra,
        timings,
        dry_run: true,
      };
      recordDecision(deps.db, {
        sourceEventId: ev.eventId,
        evidenceId: rec.evidence_id,
        zone,
        kind,
        reason,
        perception: rec.perception,
        critique: rec.critique,
        dryRun: true,
      });
      deps.writeDecision(rec);
      return rec;
    };

    if (deps.killed()) return finish('killed', 'kill_switch');
    // One evaluation per camera at a time; a burst is logged, not stacked into Ring/Bedrock.
    if (inFlight.has(ev.deviceId)) return finish('log', 'camera_busy');
    inFlight.add(ev.deviceId);
    try {
      const { frame, record } = await acquireEventFrame(ev, deps.download, clock);
      timings.frame_ready_after_event_ms = record.ready_after_event_ms;
      if (cfg.followUpProbe) {
        void probeFollowUps(ev, deps.download, clock)
          .then((f) => deps.writeProbe({ ...record, follow_ups: f }))
          .catch(() => deps.writeProbe(record));
      } else {
        deps.writeProbe(record);
      }
      if (!frame) {
        const last = record.attempts.at(-1);
        return finish('no_evidence', last?.rejected ?? last?.error_code ?? `http_${last?.status}`);
      }

      const imageSha = sha256(frame.jpeg);
      const evidenceId = evidenceIdFor(zone, ev.deviceId, frame.captureTs, imageSha);
      recordEvidence(deps.db, {
        evidenceId,
        zone,
        source: `ring:${ev.deviceId}`,
        captureTs: frame.captureTs,
        imageSha256: imageSha,
      });

      const j = await judgeFrame(frame.jpeg, frame.captureTs, evidenceId, zone, cfg, deps.converse);
      timings.perception_ms = j.perceptionMs;
      if (j.critiqueMs !== undefined) timings.critique_ms = j.critiqueMs;
      const d = j.decision;
      const age = clock.now() - frame.captureTs;
      const extra: Partial<DecisionRecord> = {
        evidence_id: evidenceId,
        evidence_age_ms: age,
        perception: j.perception,
        ...(j.critique !== undefined ? { critique: j.critique } : {}),
      };
      // Evidence must still be fresh when a profile would act (plan v7 section 4).
      if ((d.kind === 'intruder' || d.kind === 'wildlife') && age > MAX_EVIDENCE_AGE_MS) {
        return finish('reject', `stale_evidence_${age}ms_${d.kind}`, extra);
      }
      if (d.kind === 'intruder' || d.kind === 'wildlife') deps.saveFrame(evidenceId, frame.jpeg);
      return finish(d.kind, d.reason, {
        ...extra,
        would: wouldText(d.kind, zone, d.kind === 'wildlife' ? d.species : undefined),
      });
    } finally {
      inFlight.delete(ev.deviceId);
    }
  }

  return { handle };
}
