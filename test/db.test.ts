import { describe, expect, it } from 'vitest';
import {
  activeIncident,
  closeIncident,
  convertPendingIntents,
  markIntentDone,
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
    db.prepare("INSERT INTO incidents (zone, status, opened_at) VALUES ('a', 'active', 1)").run();
    expect(() =>
      db.prepare("INSERT INTO incidents (zone, status, opened_at) VALUES ('b', 'active', 2)").run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO incidents (zone, status, opened_at, level) VALUES ('c', 'exited', 3, 5)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('write-ahead intents', () => {
  it('converts only unconfirmed intents to open reconcile rows at boot', () => {
    const db = fresh();
    const inc = openIncident(db, 'front')!;
    const done = recordIntent(db, {
      incidentId: inc,
      entityId: 'light.front_spotlight',
      service: 'turn_on',
      haContextId: 'ctx-1',
    });
    markIntentDone(db, done, 'confirmed_on');
    recordIntent(db, {
      incidentId: inc,
      entityId: 'media_player.porch_speaker',
      service: 'play_media',
      haContextId: 'ctx-2',
    });
    expect(convertPendingIntents(db)).toBe(1);
    expect(openReconcileEntities(db)).toEqual(new Set(['media_player.porch_speaker']));
    const row = db.prepare('SELECT ha_context_id, reason FROM reconcile').get();
    expect(row).toEqual({ ha_context_id: 'ctx-2', reason: 'unconfirmed_intent_at_boot' });
    expect(convertPendingIntents(db)).toBe(0);
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
