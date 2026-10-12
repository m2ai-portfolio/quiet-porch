import { describe, expect, it } from 'vitest';
import { loadFixture, checkReplay, runReplay } from '../src/replay.ts';
import { handledSentence, nightReport, numberWord } from '../src/report.ts';
import { buildLedger, describeExit, describeSilent, formatLedgerLine } from '../src/ledger.ts';
import { openDb, recordDecision, recordEvent, recordOutcome } from '../src/db.ts';
import {
  latestNightWindow,
  localDate,
  logTime,
  spokenClock,
  spokenTime,
} from '../src/nightwindow.ts';

const fixturePath = new URL('./fixtures/synthetic-night.json', import.meta.url).pathname;
const TZ = 'America/Chicago';

describe('night window', () => {
  const at = (iso: string) => Date.parse(iso);

  it('mid-morning asks about the night that just ended', () => {
    const w = latestNightWindow(at('2026-10-09T08:00:00-05:00'), '20:00', '06:30', TZ);
    expect(w.from).toBe(at('2026-10-08T20:00:00-05:00'));
    expect(w.to).toBe(at('2026-10-09T06:30:00-05:00'));
    expect(w.inProgress).toBe(false);
  });

  it('inside the window it is the night in progress, before midnight and after', () => {
    for (const now of ['2026-10-08T23:00:00-05:00', '2026-10-09T02:10:00-05:00']) {
      const w = latestNightWindow(at(now), '20:00', '06:30', TZ);
      expect(w.from).toBe(at('2026-10-08T20:00:00-05:00'));
      expect(w.inProgress).toBe(true);
    }
  });

  it('a daytime question at 19:59 still reads the previous night', () => {
    const w = latestNightWindow(at('2026-10-09T19:59:00-05:00'), '20:00', '06:30', TZ);
    expect(w.from).toBe(at('2026-10-08T20:00:00-05:00'));
  });

  it('a window inside one day (no wrap) works', () => {
    const w = latestNightWindow(at('2026-10-09T12:00:00-05:00'), '01:00', '05:00', TZ);
    expect(w.from).toBe(at('2026-10-09T01:00:00-05:00'));
    expect(w.to).toBe(at('2026-10-09T05:00:00-05:00'));
  });

  it('is right across the autumn DST change (the long night)', () => {
    const w = latestNightWindow(at('2026-11-01T09:00:00-06:00'), '20:00', '06:30', TZ);
    expect(w.from).toBe(at('2026-10-31T20:00:00-05:00'));
    expect(w.to).toBe(at('2026-11-01T06:30:00-06:00'));
    expect((w.to - w.from) / 3_600_000).toBe(11.5);
  });

  it('formats spoken and logged times in the zone', () => {
    expect(spokenClock('20:00')).toBe('8 PM');
    expect(spokenClock('06:30')).toBe('6:30 AM');
    expect(spokenClock('00:00')).toBe('12 AM');
    const t = Date.parse('2026-10-09T02:14:07-05:00');
    expect(spokenTime(t, TZ)).toBe('2:14');
    expect(logTime(t, TZ)).toBe('02:14:07');
    expect(localDate(t, TZ)).toBe('2026-10-09');
  });
});

describe('ledger wording', () => {
  it('silent reasons are plain', () => {
    expect(describeSilent('log', 'nothing_actionable')).toBe('nothing to act on');
    expect(describeSilent('log', 'benign')).toBe('judged harmless');
    expect(describeSilent('reject', 'stale_evidence_21000ms_intruder')).toBe(
      'evidence too old (21 s), no action',
    );
    expect(describeSilent('reject', 'perception_not_object')).toBe('perception failed, no action');
    expect(describeSilent('no_evidence', 'http_416')).toBe('no frame (http 416)');
    expect(describeSilent('no_evidence', 'blind_encrypted')).toBe(
      'blind: camera video is encrypted',
    );
    expect(describeSilent('log', 'critique_uncertain')).toBe('judged unclear, no action');
  });

  it('exit reasons are plain', () => {
    expect(describeExit('departure', 'exited')).toBe('next frame empty');
    expect(describeExit('stand_down:stop_link', 'cancelled')).toBe('stood down (stop link)');
    expect(describeExit('expected:Lutfiya', 'cancelled')).toBe('expected (Lutfiya)');
    expect(describeExit(null, 'active')).toBe('still active');
  });

  it('numbers up to twenty are words', () => {
    expect(numberWord(14)).toBe('fourteen');
    expect(numberWord(0)).toBe('zero');
    expect(numberWord(37)).toBe('37');
  });
});

describe('synthetic night replay (F9)', () => {
  const fx = loadFixture(fixturePath);

  it('is labelled synthetic and says replay on every line', async () => {
    expect(fx.synthetic).toBe(true);
    expect(fx.label).toContain('synthetic');
    const r = await runReplay(fx);
    expect(r.lines.filter((l) => l.includes('source replay'))).toHaveLength(r.ledger.lines.length);
  });

  it('reproduces the fixture ledger three times in a row', async () => {
    const c = await checkReplay(fx, 3);
    expect(c.problems).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.runs[1]).toEqual(c.runs[0]);
    expect(c.runs[2]).toEqual(c.runs[0]);
  });

  it('events = silent + handled, with the ladder run as one line', async () => {
    const { ledger } = await runReplay(fx);
    expect(ledger.counts).toMatchObject({ events: 5, silent: 3, handled: 2, raw_events: 13 });
    const gate = ledger.lines.find((l) => l.profile === 'intruder')!;
    expect(gate.level).toBe(4);
    expect(gate.events).toBe(9); // seven person frames and two empty ones fold into one line
    expect(gate.levels.map((e) => [e.level, e.dwell_ms])).toEqual([
      [1, 0],
      [2, 20_000],
      [3, 40_000],
      [4, 60_000],
    ]);
    expect(gate.stop_reason).toBe('next frame empty');
    // The Principle 2 proof: no level fired on a frame older than the 15 s limit.
    for (const e of gate.levels) expect(e.age_ms!).toBeLessThan(15_000);
    for (const a of gate.actions) expect(a.age_ms!).toBeLessThan(15_000);
  });

  it('the wildlife run is one line with its own label', async () => {
    const { ledger, lines } = await runReplay(fx);
    const w = ledger.lines.find((l) => l.profile === 'wildlife')!;
    expect(w.what).toBe('armadillo');
    expect(w.actions.some((a) => a.service === 'open_valve')).toBe(true);
    expect(lines.some((l) => l.includes('wildlife run'))).toBe(true);
  });

  it('a changed fixture is caught (the check is not vacuous)', async () => {
    const tampered = { ...fx, expected_ledger: [...fx.expected_ledger!].reverse() };
    const c = await checkReplay(tampered, 1);
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toContain('expected_ledger');
  });
});

describe('night report (F3 wording)', () => {
  const fx = loadFixture(fixturePath);
  const opts = { timezone: TZ, start: '20:00', end: '06:30', dryRun: true };

  it('in dry run it counts honestly and says nothing was switched', async () => {
    const { ledger, endedAt } = await runReplay(fx);
    const span = latestNightWindow(endedAt, '20:00', '06:30', TZ);
    const r = nightReport(ledger, span, opts);
    expect(r.text).toBe(
      'So far tonight. Five events. Three silent. Two handled: ' +
        'a person in the front yard at 11:02, level 4. ' +
        'An armadillo in the front yard at 11:20, a wildlife run. ' +
        'Quiet Porch is in dry run, so nothing was actually switched.',
    );
    expect(r.counts.handled).toBe(2);
  });

  it('live wording reads the ladder back, with Ring-time dwell, only for outputs that completed', async () => {
    const r = await runReplay(fx, { keepDb: true });
    r.db!.exec("UPDATE action_intents SET status = 'done'; UPDATE decisions SET dry_run = 0");
    const span = latestNightWindow(r.endedAt, '20:00', '06:30', TZ);
    const live = buildLedger(r.db!, span);
    const gate = live.lines.find((l) => l.profile === 'intruder')!;
    expect(handledSentence(gate, TZ)).toBe(
      'a person in the front yard at 11:02. It switched on the outside light at 20 seconds, ' +
        'played a sound at 40 seconds and ran the sprinkler at 60 seconds. The person was gone by 11:03.',
    );
    const text = nightReport(live, span, {
      ...opts,
      dryRun: false,
      isExterior: (id) => id.startsWith('valve.') || id.startsWith('switch.'),
    }).text;
    expect(text).not.toContain('Nothing was switched outside.'); // the light and valve did switch
    expect(text).not.toContain('dry run');
    r.db!.close();
  });

  it('a refused step writes no intent, and the report does not claim it (examiner round 2 P1)', async () => {
    const r = await runReplay(fx, { keepDb: true });
    // Simulate the kill switch arriving after L2: the L3 and L4 steps were refused, no rows.
    r.db!.exec(
      "UPDATE action_intents SET status = 'done'; UPDATE decisions SET dry_run = 0; " +
        "DELETE FROM action_intents WHERE service IN ('play_clip', 'open_valve', 'set_value') " +
        "AND incident_id = (SELECT id FROM incidents WHERE profile = 'intruder')",
    );
    const span = latestNightWindow(r.endedAt, '20:00', '06:30', TZ);
    const ledger = buildLedger(r.db!, span);
    const gate = ledger.lines.find((l) => l.profile === 'intruder')!;
    expect(gate.level).toBe(4);
    expect(handledSentence(gate, TZ)).toBe(
      'a person in the front yard at 11:02. It switched on the outside light at 20 seconds, ' +
        'could not play a sound at 40 seconds and could not run the sprinkler at 60 seconds. ' +
        'The person was gone by 11:03.',
    );
    const text = nightReport(ledger, span, { ...opts, dryRun: false }).text;
    expect(text).not.toContain('played a sound');
    expect(text).not.toContain('ran the sprinkler at 60');
    r.db!.close();
  });

  it('an incident that reached L4 with no completed action at all claims nothing', async () => {
    const r = await runReplay(fx, { keepDb: true });
    r.db!.exec(
      "UPDATE decisions SET dry_run = 0; DELETE FROM action_intents WHERE incident_id = (SELECT id FROM incidents WHERE profile = 'intruder')",
    );
    const span = latestNightWindow(r.endedAt, '20:00', '06:30', TZ);
    const gate = buildLedger(r.db!, span).lines.find((l) => l.profile === 'intruder')!;
    const sentence = handledSentence(gate, TZ);
    expect(sentence).not.toMatch(/switched on|played a sound|ran the sprinkler/);
    expect(sentence).toContain('could not switch on the outside light');
    r.db!.close();
  });

  it('an empty night says silent all night with the window times', () => {
    const db = openDb(':memory:');
    const span = { from: 0, to: 1, inProgress: false };
    const empty = nightReport(buildLedger(db, span), span, { ...opts, dryRun: false });
    expect(empty.text).toBe('No events. Silent all night, 8 PM to 6:30 AM.');
    db.close();
  });

  it('counts events that were expected and cameras that were blind', () => {
    const db = openDb(':memory:');
    const t = Date.parse('2026-10-08T23:00:00-05:00');
    const mk = (id: string, ts: number, kind: 'log' | 'no_evidence', reason: string) => {
      recordEvent(
        db,
        {
          source: 'ring',
          sourceEventId: id,
          type: 'motion_detected',
          zone: 'front_yard',
          payload: { data: { attributes: { timestamp: ts, sub_type: 'human', source: 'cam' } } },
        },
        ts + 500,
      );
      recordDecision(
        db,
        { sourceEventId: id, zone: 'front_yard', kind, reason, dryRun: false },
        ts + 900,
      );
    };
    mk('a', t, 'log', 'benign');
    mk('b', t + 1000, 'no_evidence', 'blind_encrypted');
    const span = { from: t - 1000, to: t + 60_000, inProgress: false };
    const ledger = buildLedger(db, span);
    expect(ledger.counts).toMatchObject({ events: 2, silent: 2, handled: 0, blind: 1 });
    const r = nightReport(ledger, span, { ...opts, dryRun: false });
    expect(r.text).toBe(
      'Two events. One silent. One could not be seen: the camera video is encrypted.',
    );
    expect(formatLedgerLine(ledger.lines[1], TZ)[0]).toContain('blind: camera video is encrypted');
    // evidence age is decided_at minus the Ring capture time, so a missing frame is n/a
    expect(formatLedgerLine(ledger.lines[1], TZ)[0]).toContain('evidence age n/a');
    db.close();
  });
});

describe('ledger honesty (examiner round 1)', () => {
  const fx = loadFixture(fixturePath);
  const opts = { timezone: TZ, start: '20:00', end: '06:30', dryRun: false };

  it('a replay report is never "tonight" (the MCP layer adds the replay label)', async () => {
    const { ledger, endedAt } = await runReplay(fx);
    const span = latestNightWindow(endedAt, '20:00', '06:30', TZ);
    const r = nightReport(ledger, span, { ...opts, dryRun: true, source: 'replay' });
    expect(r.text.startsWith('Five events.')).toBe(true);
    expect(r.text).not.toContain('tonight');
  });

  it('the report never claims outputs that failed', async () => {
    const r = await runReplay(fx, { keepDb: true });
    r.db!.exec("UPDATE action_intents SET status = 'failed'; UPDATE decisions SET dry_run = 0");
    const span = latestNightWindow(r.endedAt, '20:00', '06:30', TZ);
    const ledger = buildLedger(r.db!, span);
    const text = nightReport(ledger, span, opts).text;
    expect(text).toContain('It reached level 4, but some actions did not complete.');
    expect(text).toContain('tried a wildlife run, but some actions did not complete');
    expect(text).not.toContain('reached level 0');
    expect(text).not.toContain('ran the sprinkler');
    expect(text).not.toContain('switched on the outside light');
    // the armadillo run opened a valve that failed too
    expect(text).toContain('but some actions did not complete');
    expect(text).not.toContain('Nothing was switched outside.');
    r.db!.close();
  });

  it('a person held back by the kill switch or a cooldown is a "held" line, not "silent: person unknown"', () => {
    const db = openDb(':memory:');
    const t = Date.parse('2026-10-08T23:00:00-05:00');
    const seed = (id: string, ts: number, note: string) => {
      recordEvent(
        db,
        {
          source: 'ring',
          sourceEventId: id,
          type: 'motion_detected',
          zone: 'front_yard',
          payload: { data: { attributes: { timestamp: ts, sub_type: 'human', source: 'cam' } } },
        },
        ts + 500,
      );
      recordDecision(
        db,
        {
          sourceEventId: id,
          zone: 'front_yard',
          kind: 'intruder',
          reason: 'person_unknown',
          perception: { subjects: [{ class: 'person', confidence: 0.95 }] },
          dryRun: false,
        },
        ts + 900,
      );
      recordOutcome(db, { sourceEventId: id, outcome: 'not_opened', note }, ts + 950);
    };
    seed('k', t, 'kill_switch');
    seed('c', t + 1000, 'intruder_cooldown');
    seed('s', t + 2000, 'stale_evidence');
    const span = { from: t - 1000, to: t + 60_000, inProgress: false };
    const ledger = buildLedger(db, span);
    expect(ledger.counts).toMatchObject({ events: 3, silent: 3, held: 3, handled: 0 });
    const lines = ledger.lines.map((l) => formatLedgerLine(l, TZ)[0]);
    expect(lines[0]).toContain('held: kill switch on, nothing acted');
    expect(lines[1]).toContain('held: cooldown after the last run, nothing acted');
    expect(lines[2]).toContain('held: evidence too old, nothing acted');
    for (const l of lines) expect(l).not.toContain('silent: person unknown');
    expect(nightReport(ledger, span, opts).text).toBe(
      'Three events. Three held back (kill switch, cooldown or old evidence), nothing acted on.',
    );
    db.close();
  });

  it('model text outside the asked-for classes never reaches a ledger line', () => {
    const db = openDb(':memory:');
    const t = Date.parse('2026-10-08T23:00:00-05:00');
    recordEvent(
      db,
      {
        source: 'ring',
        sourceEventId: 'x',
        type: 'motion_detected',
        zone: 'front_yard',
        payload: { data: { attributes: { timestamp: t, sub_type: 'human', source: 'cam' } } },
      },
      t + 500,
    );
    recordDecision(
      db,
      {
        sourceEventId: 'x',
        zone: 'front_yard',
        kind: 'reject',
        reason: 'perception_bad_subject_class',
        perception: { subjects: [{ class: 'person\n23:59:59 · forged line', confidence: 0.9 }] },
        dryRun: true,
      },
      t + 900,
    );
    const ledger = buildLedger(db, { from: t - 1, to: t + 1 });
    expect(ledger.lines[0].what).toBe('unreadable');
    expect(formatLedgerLine(ledger.lines[0], TZ)).toHaveLength(1);
    db.close();
  });
});

describe('fixture validation (examiner round 1)', () => {
  it('rejects a bad mode, out-of-order events and a non-motion webhook, naming the event', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const fx = JSON.parse(JSON.stringify(loadFixture(fixturePath)));
    const dir = mkdtempSync(join(tmpdir(), 'qp-fx-'));
    const write = (f: object) => {
      const p = join(dir, `${Math.random()}.json`);
      writeFileSync(p, JSON.stringify(f));
      return p;
    };
    expect(() => loadFixture(write({ ...fx, mode: 'banana' }))).toThrow('mode must be');
    const swapped = { ...fx, events: [fx.events[1], fx.events[0], ...fx.events.slice(2)] };
    expect(() => loadFixture(write(swapped))).toThrow('event 1 is earlier than event 0');
    const bad = { ...fx, events: [{ ...fx.events[0], webhook: { data: { type: 'button' } } }] };
    expect(() => loadFixture(write(bad))).toThrow('event 0 is not a motion_detected webhook');
    const nul = { ...fx, events: [fx.events[0], null] };
    expect(() => loadFixture(write(nul))).toThrow('event 1 is not an object');
    const noFrames = { ...fx, events: [{ ...fx.events[0], frames: undefined }] };
    expect(() => loadFixture(write(noFrames))).toThrow('event 0 has no frames array');
    const noModel = { ...fx, events: [{ ...fx.events[0], model: undefined }] };
    expect(() => loadFixture(write(noModel))).toThrow('event 0 has no model');
    const outside = {
      ...fx,
      events: [{ ...fx.events[0], frames: [{ ts_ring: 1, file: '../../etc/hosts' }] }],
    };
    expect(() => loadFixture(write(outside))).toThrow('outside the fixture folder');
    // a symlink inside the fixture folder that points out of it is refused as well
    const { symlinkSync } = await import('node:fs');
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'SECRETDATA');
    const folder = join(dir, 'fx');
    (await import('node:fs')).mkdirSync(folder);
    symlinkSync(secret, join(folder, 'link.jpg'));
    const linked = {
      ...fx,
      events: [{ ...fx.events[0], frames: [{ ts_ring: 1, file: 'link.jpg' }] }],
    };
    const lp = join(folder, 'fixture.json');
    writeFileSync(lp, JSON.stringify(linked));
    expect(() => loadFixture(lp)).toThrow('outside the fixture folder');
  });
});

describe('ledger honesty, third pass', () => {
  const fx = loadFixture(fixturePath);
  const opts = { timezone: TZ, start: '20:00', end: '06:30', dryRun: false };
  const live = async () => {
    const r = await runReplay(fx, { keepDb: true });
    r.db!.exec("UPDATE action_intents SET status = 'done'; UPDATE decisions SET dry_run = 0");
    return r;
  };
  const isExterior = (id: string) => id.startsWith('switch.') || id.startsWith('valve.');

  it('an incident that began before the window start keeps its levels, ages and outputs', async () => {
    const r = await live();
    const gate = buildLedger(r.db!, { from: 0, to: 9e15 }).lines.find(
      (l) => l.profile === 'intruder',
    )!;
    const gateStart = gate.ts_ring;
    // a window that starts after the first person frame: the incident still straddles it
    const clipped = buildLedger(r.db!, { from: gateStart + 25_000, to: 9e15 }).lines.find(
      (l) => l.profile === 'intruder',
    )!;
    expect(clipped.levels.map((e) => [e.level, e.dwell_ms])).toEqual(
      gate.levels.map((e) => [e.level, e.dwell_ms]),
    );
    expect(clipped.level).toBe(4);
    expect(handledSentence(clipped, TZ, isExterior)).toBe(handledSentence(gate, TZ, isExterior));
    expect(handledSentence(clipped, TZ, isExterior)).toContain(
      'switched on the outside light at 20 seconds',
    );
    r.db!.close();
  });

  it('an incident still running does not say "could not" for a step not yet dispatched', async () => {
    const r = await live();
    r.db!.exec(
      "UPDATE incidents SET status = 'active', exit_reason = NULL, closed_at = NULL WHERE profile = 'intruder'; " +
        "DELETE FROM action_intents WHERE service = 'open_valve' OR service = 'set_value'",
    );
    const gate = buildLedger(r.db!, { from: 0, to: 9e15 }).lines.find(
      (l) => l.profile === 'intruder',
    )!;
    const sentence = handledSentence(gate, TZ, isExterior);
    expect(sentence).not.toContain('could not');
    expect(sentence).toContain('It is still going');
    r.db!.close();
  });

  it('the outside light needs an exterior entity: an interior turn_on does not count', async () => {
    const r = await live();
    r.db!.exec(
      "DELETE FROM action_intents WHERE entity_id = 'switch.patio_light_socket_1' AND incident_id = (SELECT id FROM incidents WHERE profile = 'intruder')",
    );
    r.db!.exec(
      'INSERT INTO action_intents (intent_id, incident_id, entity_id, service, data, cls, evidence_id, dispatched_at, status) ' +
        "SELECT 'forged', incident_id, 'light.worklights', 'turn_on', '{}', 'escalation', evidence_id, dispatched_at, 'done' FROM action_intents WHERE service = 'play_clip' LIMIT 1",
    );
    const gate = buildLedger(r.db!, { from: 0, to: 9e15 }).lines.find(
      (l) => l.profile === 'intruder',
    )!;
    // the forged interior turn_on sits on the L3 frame, so L2 has nothing done on its own frame
    expect(handledSentence(gate, TZ, isExterior)).toContain(
      'could not switch on the outside light',
    );
    r.db!.close();
  });

  it('a wildlife run stopped by an expected person says so without calling the animal expected', async () => {
    const r = await live();
    r.db!.exec(
      "UPDATE incidents SET exit_reason = 'expected:Lutfiya', status = 'cancelled' WHERE profile = 'wildlife'",
    );
    const w = buildLedger(r.db!, { from: 0, to: 9e15 }).lines.find(
      (l) => l.profile === 'wildlife',
    )!;
    expect(handledSentence(w, TZ, isExterior)).toContain('A person was in the yard, so it stopped');
    expect(handledSentence(w, TZ, isExterior)).not.toContain('expected');
    r.db!.close();
  });
});
