// Only controller-owned guards can classify a pre-dispatch refusal as routine expiry.
// Provider messages and a false generic allowed() callback are never expiry evidence.
export class ActionEvidenceExpiredError extends Error {
  constructor() {
    super('action_evidence_expired');
  }
}

export class ActionGuardError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export interface ActionGuard {
  assert(): void;
  remainingMs(): number;
}

export function createActionGuard(deps: {
  captureTs: number;
  wall: () => number;
  mono: () => number;
  unsafeReason: () => string | undefined;
}): ActionGuard {
  const started = deps.mono();
  const initialRemaining = 6000 - (deps.wall() - deps.captureTs);
  function remainingMs() {
    const reason = deps.unsafeReason();
    if (reason) throw new ActionGuardError(reason);
    const age = deps.wall() - deps.captureTs;
    const elapsed = deps.mono() - started;
    if (!Number.isFinite(age) || age < 0 || !Number.isFinite(elapsed) || elapsed < 0)
      throw new ActionGuardError('clock_reversed');
    // A wall-clock correction cannot extend an already-issued action budget.
    const remaining = Math.floor(Math.min(6000 - age, initialRemaining - elapsed));
    if (remaining <= 0) throw new ActionEvidenceExpiredError();
    return remaining;
  }
  return {
    assert: () => {
      remainingMs();
    },
    remainingMs,
  };
}
