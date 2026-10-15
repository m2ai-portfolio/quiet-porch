import { describe, expect, it } from 'vitest';
import { createDryRunActuators } from '../src/actuators.ts';
import { loadAllowlist } from '../src/allowlist.ts';
import { createCoordinator, type Evaluation } from '../src/coordinator.ts';
import { activeIncident, openDb } from '../src/db.ts';
import { fakeClock } from './helpers/fake-clock.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const LIGHT = 'light.worklight_1';

function setup(holdFirstOn = false, holdSecondOn = false) {
  const db = openDb(':memory:');
  const clock = fakeClock(1_791_400_000_000);
  const dry = createDryRunActuators(() => {}, clock);
  const close = gate(),
    closeStarted = gate(),
    firstOn = gate(),
    firstOnStarted = gate();
  const secondOn = gate(),
    secondOnStarted = gate();
  const calls: string[] = [],
    completed: string[] = [];
  let onCount = 0,
    killed = false;
  const ha = {
    async call(req: Parameters<typeof dry.ha.call>[0]) {
      calls.push(req.service);
      if (req.service === 'turn_on' && ++onCount === 1 && holdFirstOn) {
        firstOnStarted.release();
        await firstOn.promise;
      }
      if (req.service === 'turn_on' && onCount === 2 && holdSecondOn) {
        secondOnStarted.release();
        await secondOn.promise;
      }
      if (req.service === 'turn_off') {
        closeStarted.release();
        await close.promise;
      }
      const result = await dry.ha.call(req);
      completed.push(req.service);
      return result;
    },
    readState: dry.ha.readState,
  };
  const coord = createCoordinator(
    {
      actuators: {
        interiorLights: [LIGHT],
        zones: {},
        clips: { bark: 'bark-5s', wildlife: 'wildlife' },
      },
      mode: 'night',
      maxIntruderLevel: 1,
      cooldownMs: 600_000,
      ownerUserIds: ['test'],
      wildlifeMaxEvidenceAgeMs: 35_000,
    },
    {
      db,
      clock,
      allowlist: loadAllowlist(new URL('../config/allowlist.json', import.meta.url).pathname),
      actuators: { ...dry, ha },
      killed: () => killed,
      log: () => {},
      stopUrl: () => '',
    },
  );
  const person = (n: number): Evaluation => ({
    zone: 'front_yard',
    kind: 'intruder',
    reason: 'person_unknown',
    evidenceId: `synthetic-${n}`,
    captureTs: clock.now(),
  });
  async function startCleanup() {
    await coord.onEvaluation(person(1));
    await coord.idle();
    coord.expectMe('owner', 10, 'test');
    await closeStarted.promise;
  }
  async function dispose() {
    firstOn.release();
    secondOn.release();
    close.release();
    await coord.idle();
    db.close();
  }
  return {
    db,
    clock,
    coord,
    calls,
    completed,
    close,
    closeStarted,
    firstOn,
    firstOnStarted,
    secondOn,
    secondOnStarted,
    person,
    startCleanup,
    dispose,
    state: () => dry.ha.readState(LIGHT),
    kill: () => {
      killed = true;
    },
  };
}

describe('expected-window cleanup owns outputs until it completes', () => {
  it('rapid cancel and new evidence wait before a new incident takes the light', async () => {
    const s = setup();
    try {
      await s.startCleanup();
      s.coord.cancelExpectation('test');
      const next = s.coord.onEvaluation(s.person(2));
      await flush();
      expect(activeIncident(s.db)).toBeUndefined();
      expect(s.calls).toEqual(['turn_on', 'turn_off']);
      s.close.release();
      await next;
      await s.coord.idle();
      expect(activeIncident(s.db)?.id).toBe(2);
      expect(s.completed).toEqual(['turn_on', 'turn_off', 'turn_on']);
      expect(await s.state()).toBe('on');
    } finally {
      await s.dispose();
    }
  });

  it('idle waits for new actions enqueued after the cleanup barrier releases', async () => {
    const s = setup(false, true);
    try {
      await s.startCleanup();
      s.coord.cancelExpectation('test');
      const next = s.coord.onEvaluation(s.person(2));
      let settled = false;
      const idle = s.coord.idle().then(() => {
        settled = true;
      });
      s.close.release();
      await s.secondOnStarted.promise;
      await flush();
      expect(settled).toBe(false);
      s.secondOn.release();
      await next;
      await idle;
      expect(await s.state()).toBe('on');
    } finally {
      await s.dispose();
    }
  });

  it('an uncancelled window still suppresses the queued person after safety cleanup', async () => {
    const s = setup();
    try {
      await s.startCleanup();
      const next = s.coord.onEvaluation(s.person(2));
      await flush();
      s.close.release();
      await next;
      await s.coord.idle();
      expect(activeIncident(s.db)).toBeUndefined();
      expect(s.calls).toEqual(['turn_on', 'turn_off']);
      expect(await s.state()).toBe('off');
    } finally {
      await s.dispose();
    }
  });

  it('repeated start/cancel operations cannot discard an outstanding cleanup barrier', async () => {
    const s = setup();
    try {
      await s.startCleanup();
      s.coord.cancelExpectation('test');
      s.coord.expectMe('owner again', 10, 'test');
      s.coord.cancelExpectation('test');
      const next = s.coord.onEvaluation(s.person(2));
      await flush();
      expect(activeIncident(s.db)).toBeUndefined();
      expect(s.calls).toEqual(['turn_on', 'turn_off']);
      s.close.release();
      await next;
      await s.coord.idle();
      expect(s.completed).toEqual(['turn_on', 'turn_off', 'turn_on']);
      expect(await s.state()).toBe('on');
    } finally {
      await s.dispose();
    }
  });

  it('a window reopened while evaluation waits is respected at execution time', async () => {
    const s = setup();
    try {
      await s.startCleanup();
      s.coord.cancelExpectation('test');
      const next = s.coord.onEvaluation(s.person(2));
      await flush();
      s.coord.expectMe('owner again', 10, 'test');
      s.close.release();
      await next;
      await s.coord.idle();
      expect(activeIncident(s.db)).toBeUndefined();
      expect(s.calls).toEqual(['turn_on', 'turn_off']);
      expect(await s.state()).toBe('off');
    } finally {
      await s.dispose();
    }
  });

  it('a timed-out close keeps the output inhibited even if its request completes late', async () => {
    const s = setup();
    try {
      await s.startCleanup();
      s.coord.cancelExpectation('test');
      const next = s.coord.onEvaluation(s.person(2));
      await flush();
      expect(activeIncident(s.db)).toBeUndefined();
      await s.clock.advance(3001);
      await next;
      await s.coord.idle();
      expect(
        s.db.prepare('SELECT id FROM reconcile WHERE resolved_at IS NULL').all().length,
      ).toBeGreaterThan(0);
      expect(s.calls.filter((c) => c === 'turn_on')).toHaveLength(1);
      s.close.release();
      await flush();
      expect(await s.state()).toBe('off');
      expect(s.calls.filter((c) => c === 'turn_on')).toHaveLength(1);
    } finally {
      await s.dispose();
    }
  });

  it('kill during the wait never cancels safety shutdown or starts a new output', async () => {
    const s = setup();
    try {
      await s.startCleanup();
      s.coord.cancelExpectation('test');
      const next = s.coord.onEvaluation(s.person(2));
      s.kill();
      s.close.release();
      await next;
      await s.coord.idle();
      expect(activeIncident(s.db)).toBeUndefined();
      expect(s.completed).toEqual(['turn_on', 'turn_off']);
      expect(await s.state()).toBe('off');
    } finally {
      await s.dispose();
    }
  });

  it('an old in-flight activation finishes and is shut down before new ownership', async () => {
    const s = setup(true);
    try {
      await s.coord.onEvaluation(s.person(1));
      await s.firstOnStarted.promise;
      s.coord.expectMe('owner', 10, 'test');
      s.coord.cancelExpectation('test');
      const next = s.coord.onEvaluation(s.person(2));
      await flush();
      expect(activeIncident(s.db)).toBeUndefined();
      s.firstOn.release();
      await s.closeStarted.promise;
      expect(s.completed).toEqual(['turn_on']);
      expect(s.calls).toEqual(['turn_on', 'turn_off']);
      s.close.release();
      await next;
      await s.coord.idle();
      expect(s.completed).toEqual(['turn_on', 'turn_off', 'turn_on']);
      expect(await s.state()).toBe('on');
    } finally {
      await s.dispose();
    }
  });
});
