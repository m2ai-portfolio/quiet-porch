import { expect, it } from 'vitest';
import { openDb, recordEvent, recordEvidence, recordDecision } from '../src/db.ts';
import { readAttendedEvidence } from '../src/attended-source.ts';
import { createAttendedTest } from '../src/attended-test.ts';

it('reads real-source signed-ingestion records through a full mocked encounter; excludes fixtures, other households and old rows', async () => {
  const db = openDb(':memory:');
  const scope = { accountId: 'owner', deviceId: 'cam', zone: 'front_yard' };
  const seen: string[] = [];
  let now = 100000;
  const session = createAttendedTest({
    scope,
    wall: () => now,
    mono: () => now - 100000,
    authorize: () => true,
    ready: async () => true,
    killed: () => false,
    audit: () => {},
    outputs: {
      alert: async () => {
        seen.push('alert');
      },
      speak: async () => {
        seen.push('speech');
      },
      stop: async () => {
        seen.push('stop');
      },
    },
  });
  let cursor = 0;
  function insert(n: number, source = 'ring', account = 'owner', person = true) {
    const eventId = `${source}-${account}-${n}`;
    recordEvent(
      db,
      {
        source,
        sourceEventId: eventId,
        type: 'motion_detected',
        zone: scope.zone,
        payload: {
          meta: { account_id: account },
          data: {
            id: eventId,
            type: 'motion_detected',
            attributes: { source: 'cam', timestamp: now },
          },
        },
      },
      now,
    );
    recordEvidence(
      db,
      {
        evidenceId: eventId,
        zone: scope.zone,
        source: 'clip',
        captureTs: now,
        imageSha256: 'hash',
      },
      now,
    );
    recordDecision(
      db,
      {
        sourceEventId: eventId,
        evidenceId: eventId,
        zone: scope.zone,
        kind: person ? 'intruder' : 'log',
        reason: 'fixture-test-only',
        dryRun: true,
        perception: {
          evidence_id: eventId,
          person_present: person,
          subjects: person ? [{ class: 'person', confidence: 0.99 }] : [],
          activity: 'standing',
          night_ir: true,
        },
      },
      now,
    );
  }
  try {
    await session.arm();
    insert(-1, 'synthetic');
    insert(-2, 'ring', 'other');
    for (let n = 0; n <= 45; n += 5) {
      now = 100000 + n * 1000;
      insert(n);
      const batch = readAttendedEvidence(db, cursor, scope);
      cursor = batch.after;
      for (const frame of batch.frames) await session.feed(frame);
    }
    now = 146000;
    insert(46, 'ring', 'owner', false);
    for (const frame of readAttendedEvidence(db, cursor, scope).frames) await session.feed(frame);
    expect(seen).toEqual(['alert', 'speech', 'stop']);
    expect(session.status().state).toBe('ended');
  } finally {
    await session.disarm();
    db.close();
  }
});
