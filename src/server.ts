// Quiet Porch Ring endpoints, served on 127.0.0.1 and exposed through Tailscale Funnel at /ring.
//
// One-way account linking (Ring docs, section 6):
//   1. Ring POSTs an authorization code to /token-exchange; we exchange it within 60 s and store
//      the tokens as UNCLAIMED, keyed by the Ring Account ID from GET /v1/users/me.
//   2. Ring redirects the browser to /link?nonce=..&time=..; the owner signs in (mandatory).
//   3. We match the nonce against unclaimed tokens, then POST + PATCH app-integrations.
// Webhooks arrive at /webhook signed with X-Signature: sha256=<hex HMAC of the raw body>.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { checkLinkFreshness, nonceMatches, verifyWebhookSignature } from './crypto.ts';
import { bedrockConfigFromEnv, converse, type ContentBlock } from './bedrock.ts';
import { openDb } from './db.ts';
import { parseMotionEvent } from './frames.ts';
import { createPipeline, parsePipelineConfig, type PipelineConfig } from './pipeline.ts';
import {
  completeIntegration,
  confirmIntegration,
  downloadImageAt,
  exchangeCode,
  getAccountId,
  listDevices,
  refreshTokens,
  type RingCredentials,
} from './ring.ts';
import { TokenStore } from './store.ts';

export interface Config {
  port: number;
  stateDir: string;
  creds: RingCredentials;
  hmacKey: string;
  linkPassword: string;
  accountLabel: string;
  // Dry-run decision pipeline (plan v7 step 2). Absent: webhooks are only logged.
  pipeline?: { config: PipelineConfig; converse: (content: ContentBlock[]) => Promise<string> };
}

const MAX_BODY_BYTES = 256 * 1024;
const REFRESH_AT_FRACTION = 0.75;
const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseFields(req: IncomingMessage, raw: Buffer): Record<string, unknown> {
  const type = req.headers['content-type'] ?? '';
  const text = raw.toString('utf8');
  if (type.includes('application/json')) return JSON.parse(text) as Record<string, unknown>;
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

// The docs do not show the field name Ring uses when it POSTs the code, so accept the likely
// spellings and log only the KEY NAMES of whatever arrives.
export function extractCode(fields: Record<string, unknown>): string | undefined {
  for (const k of ['code', 'authorization_code', 'auth_code']) {
    const v = fields[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function page(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1d1d1f;background:#fff}input,button{font:inherit;width:100%;padding:10px;margin:6px 0;box-sizing:border-box}button{background:#1d1d1f;color:#fff;border:0;border-radius:6px}.err{color:#b00020}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}}</style></head><body><h1>${title}</h1>${inner}</body></html>`;
}

function linkForm(nonce: string, time: string, error?: string): string {
  return page(
    'Quiet Porch sign-in',
    `<p>Sign in to link your Ring account to Quiet Porch.</p>${error ? `<p class="err">${error}</p>` : ''}
<form method="post" action="link"><input type="hidden" name="nonce" value="${nonce}"><input type="hidden" name="time" value="${time}">
<input type="password" name="password" placeholder="Quiet Porch password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in and link</button></form>`,
  );
}

const NONCE_RE = /^[A-Za-z0-9_-]{20,128}$/;

function passwordOk(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(cfg: Config) {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const store = new TokenStore(join(cfg.stateDir, 'tokens.json'));
  const eventsPath = join(cfg.stateDir, 'webhook-events.jsonl');
  const seenRequests = new Set<string>();
  let failures: number[] = [];
  const jsonl = (file: string) => (rec: object) =>
    appendFileSync(
      join(cfg.stateDir, file),
      `${JSON.stringify({ logged_at: new Date().toISOString(), ...rec })}\n`,
      { mode: 0o600 },
    );
  const pipeline = cfg.pipeline
    ? createPipeline(cfg.pipeline.config, {
        db: openDb(join(cfg.stateDir, 'quiet-porch.db')),
        // Read the token at call time so a refresh between attempts is picked up.
        download: (accountId, deviceId, ts, opts) => {
          const t = store.all().find((r) => r.account_id === accountId && r.claimed);
          if (!t) return Promise.reject(new Error(`no linked token for ${accountId}`));
          return downloadImageAt(t.access_token, deviceId, ts, opts);
        },
        converse: cfg.pipeline.converse,
        killed: () => existsSync(join(cfg.stateDir, 'KILL')),
        writeProbe: jsonl('frame-probe.jsonl'),
        writeDecision: (r) => {
          jsonl('decisions.jsonl')(r);
          log(`decision: ${r.kind} ${r.reason} zone=${r.zone}${r.would ? ` (${r.would})` : ''}`);
        },
        saveFrame: (evidenceId, jpeg) => {
          mkdirSync(join(cfg.stateDir, 'frames'), { recursive: true, mode: 0o700 });
          writeFileSync(join(cfg.stateDir, 'frames', `${evidenceId}.jpg`), jpeg, { mode: 0o600 });
        },
      })
    : undefined;

  async function onTokenExchange(code: string): Promise<void> {
    try {
      const t = await exchangeCode(cfg.creds, code);
      const accountId = await getAccountId(t.access_token);
      const now = Date.now();
      store.upsert({
        account_id: accountId,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        scope: t.scope,
        issued_at: now,
        expires_at: now + t.expires_in * 1000,
        claimed: false,
      });
      log(`token-exchange: stored UNCLAIMED tokens for ${accountId} (scope=${t.scope})`);
    } catch (e) {
      log(`token-exchange: FAILED ${(e as Error).message}`);
    }
  }

  async function handleLinkPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = Date.now();
    failures = failures.filter((t) => now - t < LOCKOUT_MS);
    const f = parseFields(req, await readBody(req));
    const nonce = String(f.nonce ?? '');
    const time = String(f.time ?? '');
    if (!NONCE_RE.test(nonce) || !/^\d{10,16}$/.test(time)) {
      return send(res, 400, page('Link failed', '<p class="err">Malformed link.</p>'), 'text/html');
    }
    if (failures.length >= LOCKOUT_FAILURES) {
      log('link: locked out after repeated wrong passwords');
      return send(
        res,
        429,
        linkForm(nonce, time, 'Too many attempts. Wait 15 minutes.'),
        'text/html',
      );
    }
    if (!passwordOk(String(f.password ?? ''), cfg.linkPassword)) {
      failures.push(now);
      log(`link: wrong password (${failures.length}/${LOCKOUT_FAILURES})`);
      return send(res, 401, linkForm(nonce, time, 'Wrong password.'), 'text/html');
    }
    const fresh = checkLinkFreshness(time, now);
    if (!fresh.ok) {
      log(`link: rejected, link ${fresh.reason}`);
      return send(
        res,
        400,
        page(
          'Link expired',
          `<p class="err">Link ${fresh.reason}. Start again from the Ring app.</p>`,
        ),
        'text/html',
      );
    }
    const match = store
      .unclaimed()
      .find((t) => nonceMatches(nonce, time, t.account_id, cfg.hmacKey));
    if (!match) {
      log(`link: no unclaimed token matches the nonce (${store.unclaimed().length} unclaimed)`);
      return send(
        res,
        409,
        page('Link failed', '<p class="err">No pending Ring authorization matches this link.</p>'),
        'text/html',
      );
    }
    try {
      await confirmIntegration(match.access_token, cfg.accountLabel, nonce);
      store.update(match.account_id, {
        claimed: true,
        claimed_at: now,
        integration_status: 'awaiting',
      });
      await completeIntegration(match.access_token);
      store.update(match.account_id, { integration_status: 'completed' });
      const devices = await listDevices(match.access_token);
      log(`link: COMPLETED for ${match.account_id}; devices=${devices.length}`);
      const list = devices
        .map((d) => `<li>${(d.name ?? d.id).replace(/[<>&"]/g, '')}</li>`)
        .join('');
      return send(
        res,
        200,
        page(
          'Ring account linked',
          `<p>Quiet Porch can see ${devices.length} device(s):</p><ul>${list}</ul>`,
        ),
        'text/html',
      );
    } catch (e) {
      log(`link: FAILED ${(e as Error).message}`);
      return send(
        res,
        502,
        page('Link failed', '<p class="err">Ring rejected the link. Check the service log.</p>'),
        'text/html',
      );
    }
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const sig = req.headers['x-signature'];
    if (!verifyWebhookSignature(cfg.hmacKey, raw, Array.isArray(sig) ? sig[0] : sig)) {
      log('webhook: REJECTED bad or missing X-Signature');
      return send(res, 401, '{"error":"invalid signature"}');
    }
    let body: { meta?: { request_id?: string }; data?: { type?: string } };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, '{"error":"invalid json"}');
    }
    const requestId = body.meta?.request_id;
    if (requestId && seenRequests.has(requestId)) {
      return send(res, 200, '{"status":"duplicate"}');
    }
    if (requestId) seenRequests.add(requestId);
    if (seenRequests.size > 5000) seenRequests.clear();
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ received_at: new Date().toISOString(), body })}\n`,
      {
        mode: 0o600,
      },
    );
    log(`webhook: ${body.data?.type ?? 'unknown'} request_id=${requestId ?? '-'}`);
    send(res, 200, '{"status":"processed"}');
    const motion = pipeline ? parseMotionEvent(body, Date.now()) : undefined;
    if (pipeline && motion) {
      void pipeline
        .handle(motion, body)
        .catch((e) => log(`pipeline: FAILED ${(e as Error).message}`));
    }
  }

  async function refreshDue(): Promise<void> {
    const now = Date.now();
    for (const t of store.all()) {
      const dueAt = t.issued_at + (t.expires_at - t.issued_at) * REFRESH_AT_FRACTION;
      if (now < dueAt) continue;
      try {
        const n = await refreshTokens(cfg.creds, t.refresh_token);
        store.update(t.account_id, {
          access_token: n.access_token,
          refresh_token: n.refresh_token,
          issued_at: now,
          expires_at: now + n.expires_in * 1000,
        });
        log(`refresh: renewed tokens for ${t.account_id}`);
      } catch (e) {
        log(`refresh: FAILED for ${t.account_id}: ${(e as Error).message}`);
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/^\/ring(?=\/|$)/, '') || '/';
      const route = `${req.method} ${path.replace(/\/$/, '') || '/'}`;
      switch (route) {
        case 'GET /health':
          return send(res, 200, '{"ok":true}');
        case 'POST /token-exchange': {
          const fields = parseFields(req, await readBody(req));
          log(`token-exchange: POST received, fields=[${Object.keys(fields).join(',')}]`);
          const code = extractCode(fields);
          if (!code) return send(res, 400, '{"error":"missing authorization code"}');
          void onTokenExchange(code);
          return send(res, 200, '{"status":"accepted"}');
        }
        case 'GET /link': {
          const nonce = url.searchParams.get('nonce') ?? '';
          const time = url.searchParams.get('time') ?? '';
          log(`link: GET received, params=[${[...url.searchParams.keys()].join(',')}]`);
          if (!NONCE_RE.test(nonce) || !/^\d{10,16}$/.test(time)) {
            return send(
              res,
              400,
              page('Link failed', '<p class="err">Malformed link.</p>'),
              'text/html',
            );
          }
          return send(res, 200, linkForm(nonce, time), 'text/html');
        }
        case 'POST /link':
          return await handleLinkPost(req, res);
        case 'POST /webhook':
          return await handleWebhook(req, res);
        case 'GET /home':
        case 'GET /': {
          const tokens = store.all();
          const linked = tokens.filter((t) => t.integration_status === 'completed').length;
          return send(
            res,
            200,
            page(
              'Quiet Porch',
              `<p>Running. Linked Ring accounts: ${linked}. Pending: ${tokens.length - linked}.</p>`,
            ),
            'text/html',
          );
        }
        default:
          log(`unmatched: ${req.method} ${url.pathname}`);
          return send(res, 404, '{"error":"not found"}');
      }
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, '{"error":"internal"}');
    }
  });

  return { server, store, refreshDue };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v === 'PASTE_HERE') throw new Error(`${name} is not set in the environment`);
  return v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg: Config = {
    port: Number(process.env.QUIET_PORCH_PORT ?? 3460),
    stateDir: process.env.QUIET_PORCH_STATE_DIR ?? join(homedir(), '.local/state/quiet-porch'),
    creds: {
      clientId: requireEnv('RING_CLIENT_ID'),
      clientSecret: requireEnv('RING_CLIENT_SECRET'),
    },
    hmacKey: requireEnv('RING_HMAC_KEY'),
    linkPassword: requireEnv('QUIET_PORCH_LINK_PASSWORD'),
    accountLabel: process.env.QUIET_PORCH_ACCOUNT_LABEL ?? 'owner@quiet-porch',
  };
  const configPath =
    process.env.QUIET_PORCH_CONFIG ?? join(import.meta.dirname, '../config/quiet-porch.json');
  if (process.env.QUIET_PORCH_PIPELINE !== '0' && existsSync(configPath)) {
    const bedrock = bedrockConfigFromEnv();
    cfg.pipeline = {
      config: parsePipelineConfig(JSON.parse(readFileSync(configPath, 'utf8'))),
      converse: async (content) => (await converse(bedrock, content)).text,
    };
    log(`pipeline: dry run enabled from ${configPath}`);
  }
  const { server, refreshDue } = createApp(cfg);
  server.listen(cfg.port, '127.0.0.1', () => log(`quiet-porch listening on 127.0.0.1:${cfg.port}`));
  setInterval(() => void refreshDue(), 60_000);
}
