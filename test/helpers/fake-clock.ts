// Timer-driven fake clock for coordinator tests. coordinator.test.ts keeps its own copy from
// before this helper existed; new tests use this one.
const flush = () => new Promise<void>((r) => setImmediate(r));

export function fakeClock(start: number) {
  let t = start;
  const timers: { at: number; r: () => void }[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((r) => timers.push({ at: t + ms, r })),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.r();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}
