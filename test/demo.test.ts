import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../src/demo.ts';
it('rehearses Stop, expected-window reversal, unknowns and isolated secondary data, then restores notes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-demo-'));
  let app = await createDemoServer({ stateDir: dir });
  async function listen() {
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }
  let base = await listen();
  async function action(data: object) {
    const response = await fetch(base + '/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  const first = await (await fetch(base + '/api/state')).json();
  expect(first.ledger.counts.events).toBe(5);
  expect(first.label).toContain('SYNTHETIC');
  let result = await action({ action: 'scenario', scenario: 'active' });
  expect(result.active).not.toBeNull();
  result = await action({ action: 'stop' });
  expect(result.active).toBeNull();
  expect(
    result.ledger.lines.some((l: { stop_reason: string }) => l.stop_reason.includes('stood down')),
  ).toBe(true);
  await action({ action: 'scenario', scenario: 'active' });
  result = await action({ action: 'expect' });
  expect(result.active).toBeNull();
  expect(result.expected).toBe(true);
  result = await action({ action: 'cancel' });
  expect(result.expected).toBe(false);
  result = await action({ action: 'scenario', scenario: 'historical' });
  expect(result.ledger.counts.unknown).toBe(1);
  result = await action({ action: 'scenario', scenario: 'secondary' });
  expect(
    result.ledger.lines.filter((l: { device_id: string }) => l.device_id === 'second-camera'),
  ).toHaveLength(3);
  expect(
    result.ledger.lines
      .filter((l: { device_id: string }) => l.device_id === 'second-camera')
      .every((l: { actions: unknown[] }) => l.actions.length === 0),
  ).toBe(true);
  result = await action({ action: 'scenario', scenario: 'empty' });
  expect(result.report.text).not.toContain('Silent all night');
  const denied = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { Origin: 'http://evil.invalid' },
    body: JSON.stringify({ action: 'stop' }),
  });
  expect(denied.status).toBe(403);
  await action({ action: 'note', note: 'Persisted review note' });
  await new Promise<void>((r) => app.server.close(() => r()));
  app.close();
  app = await createDemoServer({ stateDir: dir });
  base = await listen();
  const restored = await (await fetch(base + '/api/state')).json();
  expect(restored.note).toBe('Persisted review note');
  expect(restored.scenario).toBe('empty');
  await new Promise<void>((r) => app.server.close(() => r()));
  app.close();
  rmSync(dir, { recursive: true });
}, 20000);
