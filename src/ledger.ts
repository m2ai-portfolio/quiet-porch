// The night ledger (Principle 1: silence is the product, the ledger proves it). Read-only view
// over the tables the pipeline and coordinator already write; it adds no state of its own.
//   - an event nothing acted on is one "silent" line;
//   - an incident (an intruder ladder run or a wildlife run) is ONE line, anchored at its first
//     event, with the level reached, the evidence age at every level and why it stopped;
//   - so events = silent + handled, and "14 events, 13 silent, 1 handled" is arithmetic.
// Every time on a line is a Ring capture time or a time we acted on one; ages are the gap.
import type { DatabaseSync } from 'node:sqlite';
import { logTime, type NightSpan } from './nightwindow.ts';
import { SUBJECT_CLASSES } from './perception.ts';

export type LedgerSource = 'clip' | 'live' | 'replay' | 'sandbox';
export type LineKind = 'silent' | 'held' | 'expected' | 'blind' | 'handled';

export interface LedgerAction {
  service: string;
  entity_id: string;
  at: number;
  age_ms: number | null; // dispatch time minus the Ring capture time of the frame that triggered it
  status: string;
}

export interface LevelEntry {
  level: number;
  evidence_id: string | null; // the frame that earned this level
  done: { service: string; entity_id: string }[]; // what really completed on that frame (status "done")
  age_ms: number | null; // age of the frame that earned this level, when we used it
  dwell_ms: number | null; // Ring capture time of that frame minus the first frame's
}

export interface LedgerLine {
  kind: LineKind;
  ts_ring: number;
  device_id: string;
  subtype: string;
  zone: string;
  what: string;
  level: number;
  levels: LevelEntry[];
  evidence_age_ms: number | null;
  source: LedgerSource;
  dry_run: boolean;
  actions: LedgerAction[];
  stop_reason: string;
  stopped_at: number | null;
  incident_id: number | null;
  profile: 'intruder' | 'wildlife' | null;
  spoken_text: string | null;
  events: number; // webhook events folded into this line
}

export interface LedgerCounts {
  raw_events: number;
  events: number;
  silent: number;
  handled: number;
  expected: number;
  blind: number;
  held: number; // a person or animal was judged actionable, but something held the porch back
}

export interface Ledger {
  lines: LedgerLine[];
  counts: LedgerCounts;
}

interface EventRow {
  id: string;
  zone: string | null;
  ts: number;
  subtype: string | null;
  device: string | null;
  kind: string | null;
  reason: string | null;
  perception: string | null;
  dry_run: number | null;
  decided_at: number | null;
  capture_ts: number | null;
  incident_id: number | null;
  outcome: string | null;
  level_after: number | null;
  o_capture: number | null;
  o_evidence: string | null;
  applied_at: number | null;
  note: string | null;
}

interface IncidentRow {
  id: number;
  profile: 'intruder' | 'wildlife';
  closed_at: number | null;
  exit_reason: string | null;
  status: string;
}

interface IntentRow {
  incident_id: number;
  evidence_id: string | null;
  service: string;
  entity_id: string;
  dispatched_at: number;
  status: string;
  data: string;
  capture_ts: number | null;
}

// ---- plain-language reasons ----

export function describeSilent(kind: string | null, reason: string | null): string {
  const r = reason ?? '';
  const stale = /^stale_evidence_(\d+)ms_/.exec(r);
  if (stale) return `evidence too old (${Math.round(Number(stale[1]) / 1000)} s), no action`;
  if (r === 'blind_encrypted') return 'blind: camera video is encrypted';
  if (kind === 'no_evidence') return `no frame (${r.replace(/_/g, ' ')})`;
  if (/^(perception_|critique_|contradiction_|model_error)/.test(r) && r !== 'critique_uncertain') {
    return 'perception failed, no action';
  }
  if (/^person_(unknown|suspicious)_daytime_home$/.test(r)) return 'daytime visitor in home mode';
  if (/^person_with_verdict_/.test(r)) return 'person judged harmless';
  if (/^species_with_verdict_/.test(r)) return 'animal, not a nuisance';
  const known: Record<string, string> = {
    nothing_actionable: 'nothing to act on',
    benign: 'judged harmless',
    person_uncertain: 'person unclear, no action',
    critique_uncertain: 'judged unclear, no action',
    outside_night_window: 'outside the night window',
    camera_busy: 'camera busy, burst logged',
    kill_switch: 'kill switch on',
    intruder_cooldown: 'cooldown after the last run',
    wildlife_cooldown: 'cooldown after the last run',
  };
  return known[r] ?? (r.replace(/_/g, ' ') || 'logged');
}

// Why a person or animal judged actionable still got no action (coordinator outcome notes).
export function describeHeld(note: string | null): string {
  const known: Record<string, string> = {
    kill_switch: 'held: kill switch on, nothing acted',
    intruder_cooldown: 'held: cooldown after the last run, nothing acted',
    wildlife_cooldown: 'held: cooldown after the last run, nothing acted',
    stale_evidence: 'held: evidence too old, nothing acted',
  };
  return known[note ?? ''] ?? `held: ${(note ?? 'unknown').replace(/_/g, ' ')}, nothing acted`;
}

export function describeExit(reason: string | null, status: string): string {
  if (status === 'active' || !reason) return 'still active';
  if (reason.startsWith('stand_down:'))
    return `stood down (${reason.slice(11).replace(/_/g, ' ')})`;
  if (reason.startsWith('expected:')) return `expected (${reason.slice(9)})`;
  const known: Record<string, string> = {
    departure: 'next frame empty',
    benign_reclassification: 'reclassified harmless',
    bad_evidence: 'evidence unclear three times',
    timeout: 'timed out',
    restart: 'service restarted',
    completed: 'run finished',
    preempted: 'handed to the intruder ladder',
  };
  return known[reason] ?? reason.replace(/_/g, ' ');
}

// ---- building ----

function whatOf(perception: string | null, subtype: string | null, kind: string | null): string {
  if (!perception) return kind === 'no_evidence' ? 'no frame' : (subtype ?? 'motion');
  try {
    const p = JSON.parse(perception) as { subjects?: { class: string; confidence: number }[] };
    const top = [...(p.subjects ?? [])].sort((a, b) => b.confidence - a.confidence)[0];
    // Model text never reaches the ledger unless it is one of the classes we asked for.
    if (!top) return 'nothing';
    return (SUBJECT_CLASSES as readonly string[]).includes(top.class) ? top.class : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function spokenTextOf(intents: IntentRow[]): string | null {
  for (const i of intents) {
    try {
      const t = (JSON.parse(i.data) as { spoken_text?: unknown }).spoken_text;
      if (typeof t === 'string' && t) return t;
    } catch {
      /* intent data is ours; an unparsable row just has no spoken text */
    }
  }
  return null;
}

function ageOf(applied: number | null, capture: number | null): number | null {
  return applied !== null && capture !== null ? applied - capture : null;
}

function levelEntries(rows: EventRow[]): LevelEntry[] {
  const out: LevelEntry[] = [];
  const first = rows.find((r) => r.o_capture !== null)?.o_capture ?? null;
  let top = 0;
  const ordered = [...rows].sort((a, b) => (a.applied_at ?? 0) - (b.applied_at ?? 0));
  for (const r of ordered) {
    const lvl = r.level_after ?? 0;
    for (let l = top + 1; l <= lvl; l++) {
      out.push({
        level: l,
        evidence_id: r.o_evidence,
        done: [],
        age_ms: ageOf(r.applied_at, r.o_capture),
        dwell_ms: first !== null && r.o_capture !== null ? r.o_capture - first : null,
      });
    }
    top = Math.max(top, lvl);
  }
  return out;
}

export function buildLedger(
  db: DatabaseSync,
  span: Pick<NightSpan, 'from' | 'to'>,
  opts: { source?: LedgerSource } = {},
): Ledger {
  const source = opts.source ?? 'clip';
  const rows = db
    .prepare(
      `SELECT e.source_event_id AS id, e.zone AS zone,
         COALESCE(CAST(json_extract(e.payload, '$.data.attributes.timestamp') AS INTEGER), e.received_at) AS ts,
         json_extract(e.payload, '$.data.attributes.sub_type') AS subtype,
         json_extract(e.payload, '$.data.attributes.source') AS device,
         d.kind AS kind, d.reason AS reason, d.perception AS perception, d.dry_run AS dry_run,
         d.decided_at AS decided_at, ev.capture_ts AS capture_ts,
         o.incident_id AS incident_id, o.outcome AS outcome, o.level_after AS level_after,
         o.capture_ts AS o_capture, o.evidence_id AS o_evidence, o.applied_at AS applied_at, o.note AS note
       FROM events e
       LEFT JOIN decisions d ON d.source_event_id = e.source_event_id
       LEFT JOIN evidence ev ON ev.evidence_id = d.evidence_id
       LEFT JOIN event_outcomes o ON o.source_event_id = e.source_event_id
       WHERE e.type = 'motion_detected' AND ts BETWEEN ? AND ?
       ORDER BY ts, e.id`,
    )
    .all(span.from, span.to) as unknown as EventRow[];

  const byIncident = new Map<number, EventRow[]>();
  const lines: LedgerLine[] = [];
  for (const r of rows) {
    if (r.incident_id !== null) {
      byIncident.set(r.incident_id, [...(byIncident.get(r.incident_id) ?? []), r]);
      continue;
    }
    const expected = r.outcome === 'expected';
    const blind = r.reason === 'blind_encrypted';
    const held = r.outcome === 'not_opened';
    lines.push({
      kind: expected ? 'expected' : blind ? 'blind' : held ? 'held' : 'silent',
      ts_ring: r.ts,
      device_id: r.device ?? '',
      subtype: r.subtype ?? 'unknown',
      zone: r.zone ?? 'unmapped',
      what: whatOf(r.perception, r.subtype, r.kind),
      level: 0,
      levels: [],
      evidence_age_ms: ageOf(r.decided_at, r.capture_ts),
      source,
      dry_run: r.dry_run !== 0,
      actions: [],
      stop_reason: expected
        ? `expected (${r.note ?? 'owner said so'}), ladder stayed at L0`
        : held
          ? describeHeld(r.note)
          : describeSilent(r.kind, r.reason),
      stopped_at: null,
      incident_id: null,
      profile: null,
      spoken_text: null,
      events: 1,
    });
  }

  for (const [id, evs] of byIncident) {
    const inc = db
      .prepare('SELECT id, profile, closed_at, exit_reason, status FROM incidents WHERE id = ?')
      .get(id) as unknown as IncidentRow | undefined;
    if (!inc) continue;
    const intents = db
      .prepare(
        `SELECT i.incident_id, i.evidence_id, i.service, i.entity_id, i.dispatched_at, i.status, i.data, ev.capture_ts
         FROM action_intents i LEFT JOIN evidence ev ON ev.evidence_id = i.evidence_id
         WHERE i.incident_id = ? AND i.cls = 'escalation' ORDER BY i.id`,
      )
      .all(id) as unknown as IntentRow[];
    const first = evs[0];
    // Levels come from EVERY outcome row of the incident, not only the rows inside the window:
    // an incident that began before the window start still has its early levels, ages and outputs.
    const all = db
      .prepare(
        'SELECT level_after, capture_ts AS o_capture, evidence_id AS o_evidence, applied_at FROM event_outcomes WHERE incident_id = ?',
      )
      .all(id) as unknown as EventRow[];
    const levels = levelEntries(all);
    // An output counts as done only if an intent on the frame that earned the level completed.
    // A refused step (kill switch, stale evidence, audio cap) writes no intent, so it shows here
    // as a level with nothing done.
    for (const e of levels) {
      e.done = intents
        .filter(
          (i) => i.status === 'done' && i.evidence_id !== null && i.evidence_id === e.evidence_id,
        )
        .map((i) => ({ service: i.service, entity_id: i.entity_id }));
    }
    const top = levels.at(-1);
    const level = Math.max(0, ...all.map((r) => r.level_after ?? 0));
    const last = evs.at(-1)!;
    lines.push({
      kind: 'handled',
      ts_ring: first.ts,
      device_id: first.device ?? '',
      subtype: first.subtype ?? 'unknown',
      zone: first.zone ?? 'unmapped',
      what: whatOf(first.perception, first.subtype, first.kind),
      level,
      levels,
      evidence_age_ms: top ? top.age_ms : ageOf(last.applied_at, last.o_capture),
      source,
      dry_run: first.dry_run !== 0,
      actions: intents.map((i) => ({
        service: i.service,
        entity_id: i.entity_id,
        at: i.dispatched_at,
        age_ms: ageOf(i.dispatched_at, i.capture_ts),
        status: i.status,
      })),
      stop_reason: describeExit(inc.exit_reason, inc.status),
      stopped_at: inc.closed_at,
      incident_id: id,
      profile: inc.profile,
      spoken_text: spokenTextOf(intents),
      events: evs.length,
    });
  }

  lines.sort((a, b) => a.ts_ring - b.ts_ring);
  const handled = lines.filter((l) => l.kind === 'handled').length;
  const silent = lines.length - handled;
  return {
    lines,
    counts: {
      raw_events: rows.length,
      events: lines.length,
      silent,
      handled,
      expected: lines.filter((l) => l.kind === 'expected').length,
      blind: lines.filter((l) => l.kind === 'blind').length,
      held: lines.filter((l) => l.kind === 'held').length,
    },
  };
}

// ---- formatting ----

const LEVEL_WORD = ['', 'alert', 'light', 'spoke', 'valve'];

export function fmtSeconds(ms: number | null): string {
  return ms === null ? 'n/a' : `${Math.round(ms / 100) / 10} s`;
}

export function zoneLabel(zone: string): string {
  return zone.replace(/_/g, ' ');
}

function levelText(l: LedgerLine): string {
  if (l.profile === 'wildlife') return 'wildlife run';
  if (l.level === 0) return 'L0';
  const word = l.level === 3 && !l.spoken_text ? 'clip' : LEVEL_WORD[l.level];
  return `L${l.level} (${word})`;
}

// One or two strings per line: the ledger line and, for a handled incident, the age at every
// level (the Proof beat: a level fired on a frame older than its limit would show here).
export function formatLedgerLine(l: LedgerLine, timeZone: string): string[] {
  const head = [
    logTime(l.ts_ring, timeZone),
    l.what,
    zoneLabel(l.zone),
    levelText(l),
    `evidence age ${fmtSeconds(l.evidence_age_ms)}`,
    `source ${l.source}`,
  ];
  if (l.dry_run) head.push('dry run');
  if (l.kind === 'handled') {
    const stopped = l.stopped_at === null ? '' : ` ${logTime(l.stopped_at, timeZone)}`;
    head.push(
      l.stop_reason === 'still active' ? 'still active' : `stopped: ${l.stop_reason}${stopped}`,
    );
  } else {
    head.push(l.kind === 'silent' ? `silent: ${l.stop_reason}` : l.stop_reason);
  }
  const out = [head.join(' · ')];
  if (l.kind === 'handled' && l.levels.length) {
    const pad = ' '.repeat(10);
    out.push(
      `${pad}${l.levels
        .map((e) => `L${e.level} at ${fmtSeconds(e.dwell_ms)}, age ${fmtSeconds(e.age_ms)}`)
        .join(' · ')}`,
    );
  }
  if (l.spoken_text) out.push(`${' '.repeat(10)}said: "${l.spoken_text}"`);
  return out;
}

export function formatLedger(lines: LedgerLine[], timeZone: string): string[] {
  return lines.flatMap((l) => formatLedgerLine(l, timeZone));
}

// True when every action the run tried actually went through (a dry run counts as through:
// it is labelled as a dry run everywhere else).
export function allActionsDone(l: LedgerLine): boolean {
  return l.actions.every((a) => a.status === 'done' || a.status === 'dry_run');
}
