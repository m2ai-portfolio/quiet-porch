import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, openIncident } from '../src/db.ts';
import { createStatusMcp, fileModeStore, loadOrCreateTokens, type ModeStore } from '../src/mcp.ts';

const tokens = { read: 'read-token-0123456789', owner: 'owner-token-0123456789' };

describe('status-mcp over Streamable HTTP', () => {
  let base: string;
  let close: () => void;
  let db: ReturnType<typeof openDb>;
  let mode: ModeStore;
  let standDown: ReturnType<typeof vi.fn>;
  let killed = false;

  beforeEach(async () => {
    db = openDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'qp-mcp-'));
    mode = fileModeStore(join(dir, 'mode.json'), 'home');
    standDown = vi.fn(async () => 'stopped' as const);
    killed = false;
    const { server } = createStatusMcp({
      db,
      tokens,
      mode,
      killed: () => killed,
      dryRun: true,
      standDown,
      clearReconcile: () => true,
      allowedOrigins: ['http://10.0.0.46:3470'],
      log: () => {},
      now: () => 1_000_000,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    close = () => server.close();
  });
  afterEach(() => close());

  let nextId = 1;
  const rpc = async (
    method: string,
    params: object = {},
    token: string | undefined = tokens.read,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    return { status: res.status, body: res.status === 202 ? undefined : await res.json() };
  };
  const call = (name: string, args: object = {}, token = tokens.read) =>
    rpc('tools/call', { name, arguments: args }, token);

  it('unauthenticated requests get 401 with a Bearer challenge', async () => {
    const res = await fetch(base, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await rpc('ping', {}, 'wrong-token')).status).toBe(401);
  });

  it('initialize negotiates the protocol version and advertises tools only', async () => {
    const r = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(r.body.result.protocolVersion).toBe('2025-11-25');
    expect(r.body.result.capabilities).toEqual({ tools: { listChanged: false } });
    const old = await rpc('initialize', { protocolVersion: '2024-01-01' });
    expect(old.body.result.protocolVersion).toBe('2025-11-25');
  });

  it('notifications get 202 with no body; GET is 405; a foreign Origin is 403', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.read}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    const get = await fetch(base, { headers: { Authorization: `Bearer ${tokens.read}` } });
    expect(get.status).toBe(405);
    expect((await rpc('ping', {}, tokens.read, { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect((await rpc('ping', {}, tokens.read, { Origin: 'http://10.0.0.46:3470' })).status).toBe(
      200,
    );
  });

  it('an unsupported MCP-Protocol-Version header is a 400', async () => {
    expect(
      (await rpc('ping', {}, tokens.read, { 'MCP-Protocol-Version': '1999-01-01' })).status,
    ).toBe(400);
  });

  it('tools/list names the five tools with schemas and annotations', async () => {
    const r = await rpc('tools/list');
    const names = r.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'get_incident_status',
      'list_recent_incidents',
      'stand_down',
      'set_mode',
      'clear_reconcile',
    ]);
    expect(r.body.result.tools[0].annotations.readOnlyHint).toBe(true);
  });

  it('"is everything okay?" is calm and short, and says dry run', async () => {
    const r = await call('get_incident_status');
    expect(r.body.result.content[0].text).toBe(
      'All quiet. No active incident. Mode is home. Quiet Porch is in dry run: it only logs what it would do.',
    );
    openIncident(db, 'front_yard', 'intruder', 1_000_000 - 120_000);
    killed = true;
    const r2 = await call('get_incident_status');
    expect(r2.body.result.content[0].text).toContain(
      'active intruder incident in the front yard, at level 0, opened 2 minutes ago',
    );
    expect(r2.body.result.content[0].text).toContain('kill switch is on');
    expect(r2.body.result.structuredContent.active_incident.zone).toBe('front_yard');
  });

  it('a read token cannot stand down or set the mode', async () => {
    openIncident(db, 'front_yard', 'intruder', 1);
    const s = await call('stand_down');
    expect(s.body.result.isError).toBe(true);
    expect(standDown).not.toHaveBeenCalled();
    const m = await call('set_mode', { mode: 'away' });
    expect(m.body.result.isError).toBe(true);
    expect(mode.get()).toBe('home');
  });

  it('the owner token stands down the active incident and sets the mode (persisted)', async () => {
    const id = openIncident(db, 'front_yard', 'intruder', 1)!;
    const s = await call('stand_down', {}, tokens.owner);
    expect(standDown).toHaveBeenCalledWith(id, 'mcp');
    expect(s.body.result.content[0].text).toBe('Done. Everything has been turned off.');
    const m = await call('set_mode', { mode: 'away' }, tokens.owner);
    expect(m.body.result.content[0].text).toBe('Mode set to away.');
    expect(mode.get()).toBe('away');
    const bad = await call('set_mode', { mode: 'party' }, tokens.owner);
    expect(bad.body.result.isError).toBe(true);
  });

  it('recent incidents read naturally', async () => {
    const id = openIncident(db, 'front_yard', 'intruder', 1_000_000 - 60_000)!;
    db.prepare(
      "UPDATE incidents SET status = 'cancelled', exit_reason = 'stand_down:mcp' WHERE id = ?",
    ).run(id);
    const r = await call('list_recent_incidents');
    expect(r.body.result.content[0].text).toBe(
      'intruder in the front yard, 60 seconds ago, ended: it was stood down.',
    );
  });

  it('stand_down with nothing active says so', async () => {
    const s = await call('stand_down', {}, tokens.owner);
    expect(s.body.result.content[0].text).toBe('Nothing to stand down. All quiet.');
    expect(standDown).not.toHaveBeenCalled();
  });

  it('serves the simulated Alexa+ page without auth; it contains no token', async () => {
    const res = await fetch(base.replace(/\/mcp$/, '/alexa'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Quiet Porch, by voice');
    expect(html).not.toContain(tokens.read);
    expect(html).not.toContain(tokens.owner);
  });

  it('unknown tools and methods are JSON-RPC errors', async () => {
    expect((await call('unlock_door')).body.error.code).toBe(-32602);
    expect((await rpc('resources/list')).body.error.code).toBe(-32601);
  });
});

describe('token and mode files', () => {
  it('tokens are generated once, mode 600, and reused', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'qp-tok-')), 'mcp-tokens.json');
    const a = loadOrCreateTokens(p);
    expect(a.read).not.toBe(a.owner);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadOrCreateTokens(p)).toEqual(a);
  });

  it('the mode survives a restart and ignores garbage', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'qp-mode-')), 'mode.json');
    fileModeStore(p, 'home').set('night');
    expect(fileModeStore(p, 'home').get()).toBe('night');
    expect(JSON.parse(readFileSync(p, 'utf8')).mode).toBe('night');
  });
});
