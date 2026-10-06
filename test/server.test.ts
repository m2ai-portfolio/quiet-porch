import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeNonce } from '../src/crypto.ts';
import { createApp, type Config } from '../src/server.ts';

const HMAC = 'test-hmac-key';
const ACCOUNT = 'ava1.ring.account.TEST';

interface RingCall {
  url: string;
  method: string;
  body?: string;
}

// Fake Ring: records every outbound call and answers like the documented endpoints.
function fakeRing(calls: RingCall[], opts: { failPost?: boolean } = {}) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.endsWith('/oauth/token')) {
      return json(200, {
        access_token: 'AT-1',
        refresh_token: 'RT-1',
        scope: 'ava.v1:read',
        expires_in: 14400,
        token_type: 'Bearer',
      });
    }
    if (url.endsWith('/v1/users/me')) return json(200, { data: { type: 'users', id: ACCOUNT } });
    if (url.endsWith('/v1/accounts/me/app-integrations') && method === 'POST') {
      return opts.failPost ? json(400, { error: 'bad nonce' }) : json(200, {});
    }
    if (url.endsWith('/v1/accounts/me/app-integrations') && method === 'PATCH')
      return json(200, {});
    if (url.endsWith('/v1/devices')) {
      return json(200, { data: [{ id: 'd1', attributes: { name: 'Front Door' } }] });
    }
    return json(404, {});
  });
}

describe('quiet-porch server', () => {
  let dir: string;
  let base: string;
  let app: ReturnType<typeof createApp>;
  let calls: RingCall[];
  const realFetch = globalThis.fetch;

  async function start(opts: { failPost?: boolean } = {}) {
    calls = [];
    dir = mkdtempSync(join(tmpdir(), 'qp-'));
    const cfg: Config = {
      port: 0,
      stateDir: dir,
      creds: { clientId: 'cid', clientSecret: 'secret' },
      hmacKey: HMAC,
      linkPassword: 'correct horse',
      accountLabel: 'owner@quiet-porch',
    };
    app = createApp(cfg);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // The server's own outbound calls go to the fake; the test's calls use the real fetch.
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) =>
      String(input).startsWith(base) ? realFetch(input, init) : ring(input, init),
    );
    const ring = fakeRing(calls, opts);
  }

  beforeEach(async () => start());
  afterEach(() => {
    app.server.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  async function exchange() {
    const r = await fetch(`${base}/ring/token-exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-1' }),
    });
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(app.store.unclaimed()).toHaveLength(1));
  }

  function linkPost(fields: Record<string, string>) {
    return fetch(`${base}/ring/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('token exchange stores tokens as UNCLAIMED under the users/me account id', async () => {
    await exchange();
    const [rec] = app.store.unclaimed();
    expect(rec.account_id).toBe(ACCOUNT);
    expect(rec.claimed).toBe(false);
    const grant = calls.find((c) => c.url.endsWith('/oauth/token'));
    expect(new URLSearchParams(grant?.body).get('grant_type')).toBe('authorization_code');
    expect(new URLSearchParams(grant?.body).get('code')).toBe('auth-code-1');
  });

  it('token exchange without a code is a 400 and calls nothing', async () => {
    const r = await fetch(`${base}/token-exchange`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('wrong password does not claim the token or call Ring', async () => {
    await exchange();
    const time = String(Date.now());
    const r = await linkPost({ nonce: computeNonce(time, ACCOUNT, HMAC), time, password: 'nope' });
    expect(r.status).toBe(401);
    expect(app.store.unclaimed()).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('app-integrations'))).toBe(false);
  });

  it('locks out after 5 wrong passwords, even for the right one', async () => {
    await exchange();
    const time = String(Date.now());
    const nonce = computeNonce(time, ACCOUNT, HMAC);
    for (let i = 0; i < 5; i++) await linkPost({ nonce, time, password: 'nope' });
    const r = await linkPost({ nonce, time, password: 'correct horse' });
    expect(r.status).toBe(429);
    expect(app.store.unclaimed()).toHaveLength(1);
  });

  it('a nonce for another account is rejected with 409', async () => {
    await exchange();
    const time = String(Date.now());
    const r = await linkPost({
      nonce: computeNonce(time, 'ava1.ring.account.OTHER', HMAC),
      time,
      password: 'correct horse',
    });
    expect(r.status).toBe(409);
    expect(app.store.unclaimed()).toHaveLength(1);
  });

  it('an expired link is rejected before any Ring call', async () => {
    await exchange();
    const time = String(Date.now() - 601_000);
    const r = await linkPost({
      nonce: computeNonce(time, ACCOUNT, HMAC),
      time,
      password: 'correct horse',
    });
    expect(r.status).toBe(400);
    expect(calls.some((c) => c.url.includes('app-integrations'))).toBe(false);
  });

  it('correct sign-in runs POST (nonce) then PATCH (completed) and lists devices', async () => {
    await exchange();
    const time = String(Date.now());
    const nonce = computeNonce(time, ACCOUNT, HMAC);
    const r = await linkPost({ nonce, time, password: 'correct horse' });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Front Door');
    const integ = calls.filter((c) => c.url.includes('app-integrations'));
    expect(integ.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(JSON.parse(integ[0].body ?? '{}')).toEqual({
      account_identifier: 'owner@quiet-porch',
      nonce,
    });
    expect(JSON.parse(integ[1].body ?? '{}')).toEqual({ status: 'completed' });
    expect(app.store.all()[0]).toMatchObject({ claimed: true, integration_status: 'completed' });
  });

  it('if Ring rejects the nonce POST, the token stays unclaimed and PATCH is never sent', async () => {
    app.server.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    await start({ failPost: true });
    await exchange();
    const time = String(Date.now());
    const r = await linkPost({
      nonce: computeNonce(time, ACCOUNT, HMAC),
      time,
      password: 'correct horse',
    });
    expect(r.status).toBe(502);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(app.store.unclaimed()).toHaveLength(1);
  });

  describe('webhook', () => {
    const payload = '{"meta":{"request_id":"req-1"},"data":{"type":"motion_detected"}}';
    const sig = `sha256=${createHmac('sha256', HMAC).update(payload).digest('hex')}`;
    const post = (body: string, signature?: string) =>
      fetch(`${base}/ring/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(signature ? { 'X-Signature': signature } : {}),
        },
        body,
      });

    it('accepts a signed event and appends it to the log', async () => {
      expect((await post(payload, sig)).status).toBe(200);
      const lines = readFileSync(join(dir, 'webhook-events.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).body.data.type).toBe('motion_detected');
    });

    it('rejects a missing or wrong signature without logging', async () => {
      expect((await post(payload)).status).toBe(401);
      expect((await post(payload.replace('motion', 'button'), sig)).status).toBe(401);
      expect(() => readFileSync(join(dir, 'webhook-events.jsonl'))).toThrow();
    });

    it('deduplicates retries by meta.request_id', async () => {
      await post(payload, sig);
      const r = await post(payload, sig);
      expect(await r.json()).toEqual({ status: 'duplicate' });
      const lines = readFileSync(join(dir, 'webhook-events.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
    });
  });

  it('refreshes tokens once 75% of the access lifetime has passed', async () => {
    await exchange();
    const [rec] = app.store.all();
    app.store.update(rec.account_id, {
      issued_at: Date.now() - 4 * 3600_000,
      expires_at: Date.now() - 1,
    });
    await app.refreshDue();
    const grants = calls.filter((c) => c.url.endsWith('/oauth/token'));
    expect(new URLSearchParams(grants.at(-1)?.body).get('grant_type')).toBe('refresh_token');
    expect(app.store.all()[0].expires_at).toBeGreaterThan(Date.now());
  });

  it('GET /link reflects only a validated nonce and time', async () => {
    const ok = await fetch(`${base}/ring/link?nonce=${'a'.repeat(43)}&time=1771130906289`);
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/ring/link?nonce=%3Cscript%3E&time=1`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('<script>');
  });
});
