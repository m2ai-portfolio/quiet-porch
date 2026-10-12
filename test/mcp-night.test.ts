import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { cleanLabel, createStatusMcp, createStatusTools, type ModeStore } from '../src/mcp.ts';
import { loadFixture, runReplay } from '../src/replay.ts';

const tokens = { read: 'read-token-0123456789', owner: 'owner-token-0123456789' };
const fixture = loadFixture(new URL('./fixtures/synthetic-night.json', import.meta.url).pathname);

describe('night tools over Streamable HTTP (F3, F4, F8)', () => {
  let base: string;
  let close: () => void;
  let closeDb: () => void;
  const expectMe = vi.fn((label: string, minutes: number | undefined) => ({
    id: 1,
    person_label: label,
    created_at: 0,
    expires_at: (minutes ?? 10) * 60_000,
  }));

  beforeEach(async () => {
    expectMe.mockClear();
    const r = await runReplay(fixture, { keepDb: true });
    const mode: ModeStore = { get: () => 'away', set: () => {} };
    const { server } = createStatusMcp({
      db: r.db!,
      tokens,
      mode,
      killed: () => false,
      dryRun: true,
      standDown: async () => 'stopped',
      clearReconcile: () => true,
      expectMe,
      night: { timezone: 'America/Chicago', start: '20:00', end: '06:30' },
      source: 'replay',
      sourceLabel: fixture.label,
      allowedOrigins: [],
      log: () => {},
      now: () => r.endedAt,
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    closeDb = () => r.db!.close();
  });
  afterEach(() => {
    close();
    closeDb();
  });

  let id = 1;
  const call = async (name: string, args: object = {}, token = tokens.read) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: id++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return (await res.json()).result;
  };

  it('get_night_report answers in under 2 s with the counts and the dry-run caveat', async () => {
    const t0 = Date.now();
    const r = await call('get_night_report');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.content[0].text).toMatch(
      /^So far tonight\. Five events\. Three silent\. Two handled: /,
    );
    expect(r.content[0].text).toContain('dry run');
    expect(r.structuredContent.counts).toMatchObject({ events: 5, silent: 3, handled: 2 });
    expect(r.structuredContent.source).toBe('replay');
  });

  it('get_ledger returns one formatted line per event, every one labelled replay', async () => {
    const r = await call('get_ledger');
    const d = r.structuredContent;
    expect(d.source_label).toBe('synthetic fixture, not a real night');
    expect(d.lines).toHaveLength(5);
    expect(d.text_lines.filter((l: string) => /^\d\d:\d\d:\d\d/.test(l))).toHaveLength(5);
    expect(d.text_lines.join('\n')).toContain('source replay');
    expect(d.text_lines.join('\n')).toContain('stopped: next frame empty');
  });

  it('the read token cannot start an expected window; the owner can', async () => {
    const denied = await call('expect_me', { person_label: 'Lutfiya', minutes: 10 });
    expect(denied.isError).toBe(true);
    expect(expectMe).not.toHaveBeenCalled();
    const ok = await call('expect_me', { person_label: 'Lutfiya', minutes: 15 }, tokens.owner);
    expect(expectMe).toHaveBeenCalledWith('Lutfiya', 15, 'mcp:owner');
    expect(ok.content[0].text).toBe(
      'Okay. I will stay quiet about Lutfiya for 15 minutes, and note each time.',
    );
  });

  it('expect_me refuses an out-of-range length and cleans the label', async () => {
    const bad = await call('expect_me', { minutes: 61 }, tokens.owner);
    expect(bad.isError).toBe(true);
    expect(expectMe).not.toHaveBeenCalled();
    await call('expect_me', { person_label: 'Matt\n<script>x</script>' }, tokens.owner);
    expect(expectMe).toHaveBeenCalledWith('Mattscriptxscript', undefined, 'mcp:owner');
    expect(cleanLabel('')).toBe('someone expected');
    expect(cleanLabel('a'.repeat(100))).toHaveLength(40);
  });

  it('serves the ledger page without auth and without a token inside it', async () => {
    const res = await fetch(`${base}/ledger`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('night ledger');
    expect(html).not.toContain(tokens.read);
    expect(html).not.toContain(tokens.owner);
  });
});

describe('status with a blind camera (F12)', () => {
  it('says which camera is blind and why, in the voice answer', async () => {
    const db = openDb(':memory:');
    const tools = createStatusTools({
      db,
      tokens,
      mode: { get: () => 'night', set: () => {} },
      killed: () => false,
      dryRun: false,
      standDown: async () => 'not_active',
      clearReconcile: () => false,
      expectMe: vi.fn(),
      blindZones: () => ['front_door'],
      allowedOrigins: [],
      log: () => {},
    });
    const r = await tools.find((t) => t.name === 'get_incident_status')!.run({});
    expect(r.text).toContain('The front door camera is blind: its video is encrypted.');
    expect(r.data).toMatchObject({ blind_zones: ['front_door'] });
    db.close();
  });
});
