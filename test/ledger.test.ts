import { describe, expect, it } from 'vitest';
import { loadFixture, checkReplay, runReplay } from '../src/replay.ts';
import { handledSentence, nightReport, numberWord } from '../src/report.ts';
import { buildLedger, describeExit, describeSilent, formatLedgerLine } from '../src/ledger.ts';
import { openDb, recordDecision, recordEvent } from '../src/db.ts';
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

  it('live wording reads the ladder back, with Ring-time dwell, and ends calmly', async () => {
    const { ledger, endedAt } = await runReplay(fx);
    const live = {
      ...ledger,
      lines: ledger.lines.map((l) => ({ ...l, dry_run: false })),
    };
    const span = latestNightWindow(endedAt, '20:00', '06:30', TZ);
    const gate = live.lines.find((l) => l.profile === 'intruder')!;
    expect(handledSentence(gate, TZ)).toBe(
      'a person in the front yard at 11:02. It alerted you at once, switched on the outside light at 20 seconds, ' +
        'played a sound at 40 seconds and ran the sprinkler at 60 seconds. The person was gone by 11:03.',
    );
    const r = nightReport(live, span, {
      ...opts,
      dryRun: false,
      isExterior: (id) => id.startsWith('valve.') || id.startsWith('switch.'),
    });
    expect(r.text).not.toContain('Nothing was switched outside.'); // the light and valve did switch
    expect(r.text).not.toContain('dry run');
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
      'Two events. All silent. One could not be seen: the camera video is encrypted.',
    );
    expect(formatLedgerLine(ledger.lines[1], TZ)[0]).toContain('blind: camera video is encrypted');
    // evidence age is decided_at minus the Ring capture time, so a missing frame is n/a
    expect(formatLedgerLine(ledger.lines[1], TZ)[0]).toContain('evidence age n/a');
    db.close();
  });
});
