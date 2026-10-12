import { describe, expect, it } from 'vitest';
import { compareLedgers, exportFixture } from '../src/export-fixture.ts';
import { loadFixture, runReplay } from '../src/replay.ts';

const synthetic = loadFixture(new URL('./fixtures/synthetic-night.json', import.meta.url).pathname);
const first = (synthetic.events[0].webhook as { data: { attributes: { timestamp: number } } }).data
  .attributes.timestamp;
const last = (synthetic.events.at(-1)!.webhook as { data: { attributes: { timestamp: number } } })
  .data.attributes.timestamp;

async function exportRoundTrip(withTimings: boolean) {
  const original = await runReplay(synthetic, { keepDb: true });
  const { fixture, frames } = exportFixture(original.db!, {
    from: first - 1,
    to: last + 1,
    label: 'replay of a test night',
    mode: synthetic.mode,
    config: synthetic.config,
    allowlist: synthetic.allowlist,
    hasFrame: (id) => id.length > 0,
    ...(withTimings
      ? {
          readyAfterEventMs: () => 2000,
          modelMs: () => ({ perception: 2400, critique: 1200 }),
        }
      : {}),
  });
  original.db!.close();
  return { original, fixture, frames };
}

describe('export a recorded night into a fixture (F9)', () => {
  it('stores the real webhooks, the Ring frame times and the model answers', async () => {
    const { fixture, frames } = await exportRoundTrip(true);
    expect(fixture.events).toHaveLength(synthetic.events.length);
    expect(fixture.events[0].webhook).toEqual(synthetic.events[0].webhook);
    expect(fixture.events[0].received_at).toBe(synthetic.events[0].received_at);
    const gate = fixture.events[2];
    expect(gate.frames[0].ts_ring).toBe(
      (synthetic.events[2].webhook as { data: { attributes: { timestamp: number } } }).data
        .attributes.timestamp,
    );
    expect(gate.model.perception).toMatchObject({ subjects: [{ class: 'person' }] });
    expect(gate.model.perception).not.toHaveProperty('evidence_id');
    expect(gate.model.critique).toMatchObject({ verdict: 'unknown' });
    expect(frames.length).toBeGreaterThan(0);
  });

  it('with the probe and model timings the replay reproduces the original ledger exactly', async () => {
    const { original, fixture } = await exportRoundTrip(true);
    const again = await runReplay(fixture);
    expect(again.lines).toEqual(original.lines);
    expect(compareLedgers(original.ledger.lines, again.ledger.lines)).toEqual([]);
  });

  it('without them it still matches in time, level and stop reason, and ages differ', async () => {
    const { original, fixture } = await exportRoundTrip(false);
    const again = await runReplay(fixture);
    expect(compareLedgers(original.ledger.lines, again.ledger.lines)).toEqual([]);
    expect(again.lines).not.toEqual(original.lines); // ages: said, not hidden
  });

  it('a window with no events is an error, not an empty fixture', async () => {
    const original = await runReplay(synthetic, { keepDb: true });
    expect(() =>
      exportFixture(original.db!, {
        from: 1,
        to: 2,
        label: 'x',
        mode: 'away',
        config: {},
        allowlist: {},
      }),
    ).toThrow('no motion events');
    original.db!.close();
  });

  it('compareLedgers names the line that differs', async () => {
    const a = (await runReplay(synthetic)).ledger.lines;
    const b = a.map((l, i) => (i === 2 ? { ...l, level: 2 } : l));
    expect(compareLedgers(a, b)).toHaveLength(1);
    expect(compareLedgers(a, b)[0]).toContain('line 3');
    expect(compareLedgers(a, a.slice(0, 2))).toHaveLength(3);
  });
});
