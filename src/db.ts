// SQLite persistence (plan v6 item 9) on node:sqlite. The constraints that carry safety
// invariants live in the schema, not in application code:
//   - events.source_event_id is UNIQUE, so a redelivered webhook cannot create a second event;
//   - one_active_incident is a unique partial index on a constant column, so a second active
//     incident fails at INSERT time even under concurrent openers;
//   - action_intents is the write-ahead log; boot converts every row not marked done into an
//     open reconcile row before any event is accepted.
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

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
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'exited')),
  level INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 4),
  version INTEGER NOT NULL DEFAULT 1,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  exit_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_incident ON incidents (singleton) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cooldowns (
  zone TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS action_intents (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER REFERENCES incidents (id),
  entity_id TEXT NOT NULL,
  service TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  ha_context_id TEXT NOT NULL UNIQUE,
  dispatched_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  result TEXT
);

CREATE TABLE IF NOT EXISTS reconcile (
  id INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  incident_id INTEGER REFERENCES incidents (id),
  action TEXT NOT NULL,
  ha_context_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT CHECK (resolution IN ('context_landed_then_off', 'owner_cleared'))
);
CREATE INDEX IF NOT EXISTS reconcile_open ON reconcile (entity_id) WHERE resolved_at IS NULL;
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
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
export function openIncident(db: DatabaseSync, zone: string, now = Date.now()): number | null {
  try {
    const r = db
      .prepare("INSERT INTO incidents (zone, status, opened_at) VALUES (?, 'active', ?)")
      .run(zone, now);
    return Number(r.lastInsertRowid);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export function activeIncident(
  db: DatabaseSync,
): { id: number; zone: string; level: number; version: number } | undefined {
  return db
    .prepare("SELECT id, zone, level, version FROM incidents WHERE status = 'active'")
    .get() as { id: number; zone: string; level: number; version: number } | undefined;
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

export function recordIntent(
  db: DatabaseSync,
  i: {
    incidentId: number | null;
    entityId: string;
    service: string;
    data?: unknown;
    haContextId: string;
  },
  now = Date.now(),
): number {
  const r = db
    .prepare(
      'INSERT INTO action_intents (incident_id, entity_id, service, data, ha_context_id, dispatched_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(i.incidentId, i.entityId, i.service, JSON.stringify(i.data ?? {}), i.haContextId, now);
  return Number(r.lastInsertRowid);
}

export function markIntentDone(db: DatabaseSync, id: number, result: string): void {
  db.prepare("UPDATE action_intents SET status = 'done', result = ? WHERE id = ?").run(result, id);
}

// Boot step: every intent never confirmed becomes an open reconcile row. One transaction, so a
// crash here leaves either all intents pending or all converted.
export function convertPendingIntents(db: DatabaseSync, now = Date.now()): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const pending = db
      .prepare(
        "SELECT id, incident_id, entity_id, service, ha_context_id FROM action_intents WHERE status = 'pending'",
      )
      .all() as {
      id: number;
      incident_id: number | null;
      entity_id: string;
      service: string;
      ha_context_id: string;
    }[];
    const insert = db.prepare(
      "INSERT INTO reconcile (entity_id, incident_id, action, ha_context_id, reason, created_at) VALUES (?, ?, ?, ?, 'unconfirmed_intent_at_boot', ?)",
    );
    const done = db.prepare(
      "UPDATE action_intents SET status = 'done', result = 'converted_to_reconcile' WHERE id = ?",
    );
    for (const p of pending) {
      insert.run(p.entity_id, p.incident_id, p.service, p.ha_context_id, now);
      done.run(p.id);
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
