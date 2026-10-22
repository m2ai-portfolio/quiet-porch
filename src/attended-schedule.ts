// A scheduled start must be agreed with the human BEFORE launching this process.
// Waiting is bounded, disarmed and has no camera/notification/playback callbacks.
export const MAX_PREPARE_MS = 300000;
export const MIN_PREPARE_MS = 30000;
export const ACTIVE_WINDOW_MS = 60000;
export function validateSchedule(startsAt: number, expiresAt: number, now: number) {
  if (
    !Number.isSafeInteger(startsAt) ||
    !Number.isSafeInteger(expiresAt) ||
    startsAt - now < MIN_PREPARE_MS ||
    startsAt - now > MAX_PREPARE_MS ||
    expiresAt !== startsAt + ACTIVE_WINDOW_MS
  )
    throw new Error('invalid_scheduled_window');
}
export async function waitForAttendedStart(deps: {
  startsAt: number;
  expiresAt: number;
  signal: AbortSignal;
  permitted: () => boolean;
  preflight: () => Promise<boolean>; // read-only, bounded by this scheduler
  waiting: () => void;
  arm: () => Promise<void>;
  now?: () => number;
  mono?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = deps.now ?? Date.now;
  const mono = deps.mono ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const wall0 = now(),
    mono0 = mono();
  validateSchedule(deps.startsAt, deps.expiresAt, wall0);
  function guard() {
    if (deps.signal.aborted || !deps.permitted()) throw new Error('preparation_cancelled');
    const elapsed = mono() - mono0;
    if (elapsed < 0 || elapsed > MAX_PREPARE_MS + 2000 || Math.abs(now() - wall0 - elapsed) > 1000)
      throw new Error('preparation_clock_changed_or_expired');
    if (now() - deps.startsAt > 2000 || now() >= deps.expiresAt)
      throw new Error('scheduled_start_missed');
  }
  async function preflight() {
    guard();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        deps.preflight(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2500);
        }),
      ]);
      guard();
      if (!ready) throw new Error('scheduled_preflight_failed');
    } finally {
      clearTimeout(timer);
    }
  }
  await preflight();
  if (deps.startsAt - now() < 15000) throw new Error('insufficient_human_notice');
  deps.waiting(); // persisted notice available before arming; human already has the agreed time
  let refreshed = false;
  for (;;) {
    guard();
    const remaining = deps.startsAt - now();
    if (!refreshed && remaining <= 5000) {
      await preflight();
      refreshed = true;
      continue;
    }
    if (remaining <= 0) break;
    await sleep(Math.min(250, remaining));
  }
  guard();
  await deps.arm();
  guard(); // a late async arm may not proceed to event processing or any outputs
}
