import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeIncident,
  closeIncident,
  completeIntent,
  convertPendingIntents,
  openDb,
  openIncident,
  openReconcileEntities,
  recordEvent,
  recordIntent,
} from '../src/db.ts';

const fresh = () => openDb(':memory:');

describe('events', () => {
  it('ignores a duplicate source event id', () => {
    const db = fresh();
    const e = { source: 'ring', sourceEventId: 'req-1', type: 'motion_detected', payload: {} };
    expect(recordEvent(db, e)).toBe(true);
    expect(recordEvent(db, e)).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
  });
});

describe('incidents', () => {
  it('allows only one active incident across zones', () => {
    const db = fresh();
    const a = openIncident(db, 'front');
    expect(a).not.toBeNull();
    expect(openIncident(db, 'side')).toBeNull();
    expect(openIncident(db, 'front')).toBeNull();
    expect(activeIncident(db)).toMatchObject({ id: a, zone: 'front', level: 0, version: 1 });
  });
  it('allows a new incident after the active one closes, and bumps the version on close', () => {
    const db = fresh();
    const a = openIncident(db, 'front')!;
    closeIncident(db, a, 'exited', 'departure');
    expect(activeIncident(db)).toBeUndefined();
    const v = db.prepare('SELECT version, status FROM incidents WHERE id = ?').get(a);
    expect(v).toEqual({ version: 2, status: 'exited' });
    expect(openIncident(db, 'side')).not.toBeNull();
  });
  it('enforces the one-active rule in the schema, not only in openIncident', () => {
    const db = fresh();
    const ins = (zone: string, status: string, level = 0, profile = 'intruder') =>
      db
        .prepare(
          'INSERT INTO incidents (zone, profile, status, opened_at, level) VALUES (?, ?, ?, 1, ?)',
        )
        .run(zone, profile, status, level);
    ins('a', 'active');
    expect(() => ins('b', 'active', 0, 'wildlife')).toThrow(/UNIQUE/);
    expect(() => ins('c', 'exited', 5)).toThrow(/CHECK/);
    expect(() => ins('d', 'exited', 0, 'dog')).toThrow(/CHECK/);
  });
});

describe('write-ahead intents', () => {
  const intent = (intentId: string, entityId: string, service: string, incidentId: number) => ({
    intentId,
    incidentId,
    entityId,
    service,
    cls: 'escalation' as const,
  });

  it('converts only pending intents to open reconcile rows at boot, with outcome unknown', () => {
    const db = fresh();
    const inc = openIncident(db, 'front')!;
    recordIntent(db, intent('i-1', 'light.front_spotlight', 'turn_on', inc));
    completeIntent(db, 'i-1', 'done', 'read_back_on', 'ctx-1');
    recordIntent(db, intent('i-2', 'light.stairs', 'turn_on', inc));
    completeIntent(db, 'i-2', 'dry_run', 'would_call');
    recordIntent(db, intent('i-3', 'pi_audio.porch_speaker', 'play_clip', inc));
    expect(convertPendingIntents(db)).toBe(1);
    expect(openReconcileEntities(db)).toEqual(new Set(['pi_audio.porch_speaker']));
    const row = db.prepare('SELECT intent_id, ha_context_id, reason FROM reconcile').get();
    expect(row).toEqual({
      intent_id: 'i-3',
      ha_context_id: null,
      reason: 'unconfirmed_intent_at_boot',
    });
    expect(db.prepare("SELECT status FROM action_intents WHERE intent_id = 'i-3'").get()).toEqual({
      status: 'unknown',
    });
    expect(convertPendingIntents(db)).toBe(0);
  });

  it('never invents a context id: it stays null unless HA returned one', () => {
    const db = fresh();
    recordIntent(db, intent('i-1', 'light.x', 'turn_on', openIncident(db, 'front')!));
    completeIntent(db, 'i-1', 'unknown', 'timeout');
    expect(db.prepare('SELECT ha_context_id, status FROM action_intents').get()).toEqual({
      ha_context_id: null,
      status: 'unknown',
    });
  });

  it('closes reconcile rows only through an allowed resolution', () => {
    const db = fresh();
    db.prepare(
      "INSERT INTO reconcile (entity_id, action, reason, created_at) VALUES ('light.x', 'turn_on', 'unknown', 1)",
    ).run();
    expect(() =>
      db.prepare("UPDATE reconcile SET resolved_at = 2, resolution = 'timeout'").run(),
    ).toThrow(/CHECK/);
    db.prepare("UPDATE reconcile SET resolved_at = 2, resolution = 'owner_cleared'").run();
    expect(openReconcileEntities(db).size).toBe(0);
  });
});

describe('migration v2 -> v3', () => {
  const v2 = (path: string, withIncident: boolean) => {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, zone TEXT, received_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE incidents (id INTEGER PRIMARY KEY, zone TEXT NOT NULL, status TEXT NOT NULL, opened_at INTEGER NOT NULL);
      CREATE TABLE action_intents (id INTEGER PRIMARY KEY, ha_context_id TEXT NOT NULL UNIQUE);
      INSERT INTO events (source, source_event_id, type, received_at, payload) VALUES ('ring', 'e1', 'motion', 1, '{}');
      PRAGMA user_version = 2;`);
    if (withIncident)
      db.exec("INSERT INTO incidents (zone, status, opened_at) VALUES ('a', 'exited', 1)");
    db.close();
  };

  it('rebuilds empty coordinator tables and keeps events', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qp-')), 'db');
    v2(path, false);
    const db = openDb(path);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    expect(openIncident(db, 'front', 'wildlife')).not.toBeNull();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
  });

  it('refuses to drop coordinator rows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qp-')), 'db');
    v2(path, true);
    expect(() => openDb(path)).toThrow(/incidents has 1 rows, refusing to drop/);
  });
});
