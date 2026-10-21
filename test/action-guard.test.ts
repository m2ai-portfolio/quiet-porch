import { expect, it } from 'vitest';
import {
  ActionEvidenceExpiredError,
  ActionGuardError,
  createActionGuard,
} from '../src/action-guard.ts';

it('budgets capture freshness and does not extend it after a wall clock correction', () => {
  let wall = 105000,
    mono = 50000;
  const guard = createActionGuard({
    captureTs: 100000,
    wall: () => wall,
    mono: () => mono,
    unsafeReason: () => undefined,
  });
  expect(guard.remainingMs()).toBe(1000);
  mono += 750;
  wall -= 250;
  expect(guard.remainingMs()).toBe(250);
  mono += 250;
  expect(() => guard.assert()).toThrow(ActionEvidenceExpiredError);
});

it.each(['emergency_disarm', 'authority_revoked', 'night_window_ended', 'session_expired'])(
  'never mislabels %s as capture expiry',
  (reason) => {
    const guard = createActionGuard({
      captureTs: 100000,
      wall: () => 106000,
      mono: () => 50000,
      unsafeReason: () => reason,
    });
    expect(() => guard.assert()).toThrow(ActionGuardError);
    expect(() => guard.assert()).toThrow(reason);
  },
);

it('refuses future evidence and a reversed monotonic clock', () => {
  let mono = 50000;
  const guard = createActionGuard({
    captureTs: 100001,
    wall: () => 100000,
    mono: () => mono,
    unsafeReason: () => undefined,
  });
  expect(() => guard.assert()).toThrow('clock_reversed');
  mono--;
  expect(() => guard.assert()).toThrow('clock_reversed');
});
