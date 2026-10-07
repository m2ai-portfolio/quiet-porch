// SQLite persistence (plan v6 item 9) on node:sqlite. The constraints that carry safety
// invariants live in the schema, not in application code:
//   - events.source_event_id is UNIQUE, so a redelivered webhook cannot create a second event;
//   - one_active_incident is a unique partial index on a constant column, so a second active
//     incident fails at INSERT time even under concurrent openers;
//   - action_intents is the write-ahead log; boot converts every row still pending into an
//     open reconcile row before any event is accepted.
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  zone TEXT,
  received_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  zone TEXT NOT NULL,
  source TEXT NOT NULL,
  capture_ts INTEGER NOT NULL,
  image_sha256 TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1),
  zone TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('intruder', 'wildlife')),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'exited')),
  level INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 4),
  version INTEGER NOT NULL DEFAULT 1,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  exit_reason TEXT,
  -- intruder ladder state (plan v7 section 5); all times are frame capture times
  dwell_start_ms INTEGER,
  last_frame_ms INTEGER,
  no_person_count INTEGER NOT NULL DEFAULT 0,
  bad_evidence_count INTEGER NOT NULL DEFAULT 0,
  last_evidence_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_incident ON incidents (singleton) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cooldowns (
  zone TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('intruder', 'wildlife')),
  until_ms INTEGER NOT NULL,
  PRIMARY KEY (zone, profile)
);

-- Write-ahead log. intent_id is ours and written before dispatch; ha_context_id is only ever
-- what HA returned for that call (plan v7 section 7), so it is nullable and never invented.
CREATE TABLE IF NOT EXISTS action_intents (
  id INTEGER PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE,
  incident_id INTEGER REFERENCES incidents (id),
  entity_id TEXT NOT NULL,
  service TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  cls TEXT NOT NULL CHECK (cls IN ('safety', 'escalation')),
  evidence_id TEXT,
  ha_context_id TEXT UNIQUE,
  dispatched_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'unknown', 'failed', 'dry_run')),
  result TEXT,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS reconcile (
  id INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  incident_id INTEGER REFERENCES incidents (id),
  intent_id TEXT,
  action TEXT NOT NULL,
  ha_context_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_check_ms INTEGER,
  check_count INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  resolution TEXT CHECK (resolution IN ('context_landed_then_off', 'owner_cleared'))
);
CREATE INDEX IF NOT EXISTS reconcile_open ON reconcile (entity_id) WHERE resolved_at IS NULL;

-- Stop links are single use (plan v7 section 8).
CREATE TABLE IF NOT EXISTS stop_uses (
  sig TEXT PRIMARY KEY,
  incident_id INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  evidence_id TEXT REFERENCES evidence (evidence_id),
  zone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reject', 'log', 'intruder', 'wildlife', 'no_evidence', 'killed')),
  reason TEXT NOT NULL,
  perception TEXT,
  critique TEXT,
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  decided_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_by_time ON decisions (decided_at);
`;

// v2 -> v3 rebuilds the coordinator tables (incidents gain a profile and ladder state,
// cooldowns are per profile, intents get a local intent_id). It refuses to drop rows: in v2
// these tables were only written by tests, so a live database has none.
const V3_REBUILT = ['stop_uses', 'reconcile', 'action_intents', 'cooldowns', 'incidents'];

function migrate(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (version === 0 || version >= 3) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of V3_REBUILT) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(t);
      if (!exists) continue;
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      if (n > 0) throw new Error(`migration v${version}->v3: ${t} has ${n} rows, refusing to drop`);
    }
    for (const t of V3_REBUILT) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/.test(e.message);
}

// Returns false when the event was already recorded (duplicate delivery).
export function recordEvent(
  db: DatabaseSync,
  e: { source: string; sourceEventId: string; type: string; zone?: string; payload: unknown },
  now = Date.now(),
): boolean {
  try {
    db.prepare(
      'INSERT INTO events (source, source_event_id, type, zone, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(e.source, e.sourceEventId, e.type, e.zone ?? null, now, JSON.stringify(e.payload));
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// Returns the new incident id, or null when another incident is already active.
export type Profile = 'intruder' | 'wildlife';

export function openIncident(
  db: DatabaseSync,
  zone: string,
  profile: Profile = 'intruder',
  now = Date.now(),
): number | null {
  try {
    const r = db
      .prepare(
        "INSERT INTO incidents (zone, profile, status, opened_at) VALUES (?, ?, 'active', ?)",
      )
      .run(zone, profile, now);
    return Number(r.lastInsertRowid);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export interface IncidentRow {
  id: number;
  zone: string;
  profile: Profile;
  level: number;
  version: number;
  opened_at: number;
  dwell_start_ms: number | null;
  last_frame_ms: number | null;
  no_person_count: number;
  bad_evidence_count: number;
  last_evidence_id: string | null;
}

export function activeIncident(db: DatabaseSync): IncidentRow | undefined {
  return db
    .prepare(
      "SELECT id, zone, profile, level, version, opened_at, dwell_start_ms, last_frame_ms, no_person_count, bad_evidence_count, last_evidence_id FROM incidents WHERE status = 'active'",
    )
    .get() as IncidentRow | undefined;
}

export function closeIncident(
  db: DatabaseSync,
  id: number,
  status: 'cancelled' | 'exited',
  reason: string,
  now = Date.now(),
): void {
  db.prepare(
    "UPDATE incidents SET status = ?, exit_reason = ?, closed_at = ?, version = version + 1 WHERE id = ? AND status = 'active'",
  ).run(status, reason, now, id);
}

export interface IntentInput {
  intentId: string;
  incidentId: number | null;
  entityId: string;
  service: string;
  data?: unknown;
  cls: 'safety' | 'escalation';
  evidenceId?: string;
}

export function recordIntent(db: DatabaseSync, i: IntentInput, now = Date.now()): number {
  const r = db
    .prepare(
      'INSERT INTO action_intents (intent_id, incident_id, entity_id, service, data, cls, evidence_id, dispatched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      i.intentId,
      i.incidentId,
      i.entityId,
      i.service,
      JSON.stringify(i.data ?? {}),
      i.cls,
      i.evidenceId ?? null,
      now,
    );
  return Number(r.lastInsertRowid);
}

export function completeIntent(
  db: DatabaseSync,
  intentId: string,
  status: 'done' | 'unknown' | 'failed' | 'dry_run',
  result: string,
  haContextId?: string,
  now = Date.now(),
): void {
  db.prepare(
    "UPDATE action_intents SET status = ?, result = ?, ha_context_id = ?, completed_at = ? WHERE intent_id = ? AND status = 'pending'",
  ).run(status, result, haContextId ?? null, now, intentId);
}

export function openReconcile(
  db: DatabaseSync,
  r: {
    entityId: string;
    incidentId: number | null;
    intentId?: string;
    action: string;
    haContextId?: string;
    reason: string;
  },
  now = Date.now(),
): number {
  const res = db
    .prepare(
      'INSERT INTO reconcile (entity_id, incident_id, intent_id, action, ha_context_id, reason, created_at, next_check_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      r.entityId,
      r.incidentId,
      r.intentId ?? null,
      r.action,
      r.haContextId ?? null,
      r.reason,
      now,
      now,
    );
  return Number(res.lastInsertRowid);
}

// Boot step: every intent still pending (dispatched, outcome never recorded) becomes an open
// reconcile row with outcome unknown. One transaction, so a crash here leaves either all
// intents pending or all converted. dry_run intents never touched hardware and are skipped.
export function convertPendingIntents(db: DatabaseSync, now = Date.now()): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const pending = db
      .prepare(
        "SELECT intent_id, incident_id, entity_id, service, ha_context_id FROM action_intents WHERE status = 'pending'",
      )
      .all() as {
      intent_id: string;
      incident_id: number | null;
      entity_id: string;
      service: string;
      ha_context_id: string | null;
    }[];
    for (const p of pending) {
      openReconcile(
        db,
        {
          entityId: p.entity_id,
          incidentId: p.incident_id,
          intentId: p.intent_id,
          action: p.service,
          haContextId: p.ha_context_id ?? undefined,
          reason: 'unconfirmed_intent_at_boot',
        },
        now,
      );
      db.prepare(
        "UPDATE action_intents SET status = 'unknown', result = 'converted_to_reconcile', completed_at = ? WHERE intent_id = ?",
      ).run(now, p.intent_id);
    }
    db.exec('COMMIT');
    return pending.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function openReconcileEntities(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT entity_id FROM reconcile WHERE resolved_at IS NULL')
    .all() as { entity_id: string }[];
  return new Set(rows.map((r) => r.entity_id));
}

export function recordEvidence(
  db: DatabaseSync,
  e: { evidenceId: string; zone: string; source: string; captureTs: number; imageSha256: string },
  now = Date.now(),
): void {
  db.prepare(
    'INSERT OR IGNORE INTO evidence (evidence_id, zone, source, capture_ts, image_sha256, received_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(e.evidenceId, e.zone, e.source, e.captureTs, e.imageSha256, now);
}

export type DecisionKind = 'reject' | 'log' | 'intruder' | 'wildlife' | 'no_evidence' | 'killed';

export function recordDecision(
  db: DatabaseSync,
  d: {
    sourceEventId: string;
    evidenceId?: string;
    zone: string;
    kind: DecisionKind;
    reason: string;
    perception?: unknown;
    critique?: unknown;
    dryRun: boolean;
  },
  now = Date.now(),
): number {
  const r = db
    .prepare(
      'INSERT INTO decisions (source_event_id, evidence_id, zone, kind, reason, perception, critique, dry_run, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      d.sourceEventId,
      d.evidenceId ?? null,
      d.zone,
      d.kind,
      d.reason,
      d.perception === undefined ? null : JSON.stringify(d.perception),
      d.critique === undefined ? null : JSON.stringify(d.critique),
      d.dryRun ? 1 : 0,
      now,
    );
  return Number(r.lastInsertRowid);
}
