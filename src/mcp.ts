// status-mcp (plan v7 section 10, Alexa+ track): a tools-only MCP server over Streamable HTTP
// (spec 2025-11-25), single JSON responses, no SSE stream. LAN/tailnet only, never on the
// Funnel. Two bearer tokens: read (status, list) and owner (also stand_down, set_mode,
// clear_reconcile). Responses are short and calm, for a voice assistant to read out.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Mode } from './ladder.ts';
import { EXPECT_DEFAULT_MINUTES, EXPECT_MAX_MINUTES, type Expectation } from './db.ts';
import { buildLedger, formatLedger, type LedgerSource } from './ledger.ts';
import { latestNightWindow } from './nightwindow.ts';
import { nightReport } from './report.ts';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_BODY = 64 * 1024;
const ALEXA_SIM_HTML = readFileSync(new URL('./alexa-sim.html', import.meta.url), 'utf8');
const LEDGER_HTML = readFileSync(new URL('./ledger.html', import.meta.url), 'utf8');

export interface McpTokens {
  read: string;
  owner: string;
}

// Generated once into the state dir (mode 600), so no secret lives in the repo or env files.
export function loadOrCreateTokens(path: string): McpTokens {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as McpTokens;
  const t = {
    read: randomBytes(24).toString('base64url'),
    owner: randomBytes(24).toString('base64url'),
  };
  writeFileSync(path, JSON.stringify(t, null, 2), { mode: 0o600 });
  return t;
}

export interface ModeStore {
  get(): Mode;
  set(m: Mode): void;
}

export function fileModeStore(path: string, fallback: Mode): ModeStore {
  let mode: Mode = fallback;
  try {
    const m = (JSON.parse(readFileSync(path, 'utf8')) as { mode?: string }).mode;
    if (m === 'home' || m === 'away' || m === 'night') mode = m;
  } catch {
    /* first run: config default */
  }
  return {
    get: () => mode,
    set: (m) => {
      mode = m;
      writeFileSync(path, JSON.stringify({ mode: m, set_at: new Date().toISOString() }), {
        mode: 0o600,
      });
    },
  };
}

export interface StatusDeps {
  db: DatabaseSync;
  tokens: McpTokens;
  mode: ModeStore;
  killed: () => boolean;
  dryRun: boolean;
  standDown: (incidentId: number, by: string) => Promise<'stopped' | 'not_active'>;
  clearReconcile: (rowId: number, userId: string) => boolean;
  // "I'm stepping out": the coordinator opens a bounded window in which a person is expected.
  expectMe: (personLabel: string, minutes: number | undefined, by: string) => Expectation;
  cancelExpectation: (by: string) => number;
  // Night window the ledger and the morning report cover (config nightWindow + timezone).
  night?: { timezone: string; start: string; end: string };
  // Zones whose camera Ring encrypts (F12); the status answer says they are blind.
  blindZones?: () => string[];
  // True for an entity placed outside the house; lets the report say "nothing outside".
  isExterior?: (entityId: string) => boolean;
  // Where the frames came from; a replay or sandbox ledger is labelled so on every line.
  source?: LedgerSource;
  sourceLabel?: string; // e.g. "replay of 2026-10-12", burned into the ledger page header
  allowedOrigins: string[];
  log: (msg: string) => void;
  now?: () => number;
}

type Role = 'read' | 'owner';

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: object;
  role: Role;
  run: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

interface ToolResult {
  text: string;
  data?: object;
  isError?: boolean;
}

const EXIT_SPOKEN: Record<string, string> = {
  departure: 'the person left',
  benign_reclassification: 'it turned out to be nothing',
  bad_evidence: 'the camera view was unclear',
  timeout: 'it timed out',
  restart: 'Quiet Porch restarted',
  completed: 'the run finished',
  preempted: 'a person arrived, so it switched to the intruder response',
};

export function spokenExit(reason: string | null, status: string): string {
  if (!reason) return status;
  if (reason.startsWith('stand_down:')) return 'it was stood down';
  return EXIT_SPOKEN[reason] ?? reason.replace(/_/g, ' ');
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  return `${Math.round(s / 3600)} hours ago`;
}

// Goes into the ledger and the logs: short, one line, printable.
export function cleanLabel(raw: unknown): string {
  const t = String(raw ?? '')
    .replace(/[^\p{L}\p{N} '.,-]/gu, '')
    .trim()
    .slice(0, 40);
  return t || 'someone expected';
}

function tokenRole(header: string | undefined, tokens: McpTokens): Role | undefined {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return undefined;
  const eq = (a: string, b: string) => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  };
  if (eq(m[1], tokens.owner)) return 'owner';
  if (eq(m[1], tokens.read)) return 'read';
  return undefined;
}

export function createStatusTools(deps: StatusDeps): Tool[] {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  const active = () =>
    db
      .prepare("SELECT id, zone, profile, level, opened_at FROM incidents WHERE status = 'active'")
      .get() as
      { id: number; zone: string; profile: string; level: number; opened_at: number } | undefined;
  const openRows = () =>
    db
      .prepare(
        'SELECT id, entity_id, reason, created_at FROM reconcile WHERE resolved_at IS NULL ORDER BY id',
      )
      .all() as { id: number; entity_id: string; reason: string; created_at: number }[];

  return [
    {
      name: 'get_incident_status',
      title: 'Is everything okay?',
      description:
        'Current Quiet Porch status: any active incident, the house mode, the kill switch, and devices awaiting a check.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      role: 'read',
      run: () => {
        const inc = active();
        const rows = openRows();
        const last = db.prepare('SELECT MAX(decided_at) AS t FROM decisions').get() as {
          t: number | null;
        };
        const parts: string[] = [];
        if (deps.source && deps.source !== 'clip' && deps.source !== 'live') {
          parts.push(`${deps.source === 'replay' ? 'Replay' : 'Sandbox'}, not live.`);
        }
        if (!inc) parts.push('All quiet. No active incident.');
        else if (inc.profile === 'wildlife') {
          parts.push(`A wildlife run is in progress in the ${inc.zone.replace(/_/g, ' ')}.`);
        } else {
          parts.push(
            `There is an active intruder incident in the ${inc.zone.replace(/_/g, ' ')}, at level ${inc.level}, opened ${ago(now() - inc.opened_at)}.`,
          );
        }
        parts.push(`Mode is ${deps.mode.get()}.`);
        const blind = deps.blindZones?.() ?? [];
        for (const z of blind) {
          parts.push(`The ${z.replace(/_/g, ' ')} camera is blind: its video is encrypted.`);
        }
        if (deps.killed()) parts.push('The kill switch is on, so nothing will be turned on.');
        if (rows.length) parts.push(`${rows.length} device(s) are waiting for an owner check.`);
        if (deps.dryRun) parts.push('Quiet Porch is in dry run: it only logs what it would do.');
        return {
          text: parts.join(' '),
          data: {
            active_incident: inc ?? null,
            mode: deps.mode.get(),
            blind_zones: blind,
            source: deps.source ?? 'clip',
            source_label: deps.sourceLabel ?? null,
            kill_switch: deps.killed(),
            dry_run: deps.dryRun,
            open_reconcile: rows,
            last_decision_at: last.t,
          },
        };
      },
    },
    {
      name: 'list_recent_incidents',
      title: 'Recent incidents',
      description: 'The most recent incidents, newest first, with how each one ended.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      role: 'read',
      run: (args) => {
        const limit = Math.min(20, Math.max(1, Number(args.limit ?? 5) || 5));
        const rows = db
          .prepare(
            'SELECT id, zone, profile, status, level, opened_at, closed_at, exit_reason FROM incidents ORDER BY id DESC LIMIT ?',
          )
          .all(limit) as {
          id: number;
          zone: string;
          profile: string;
          status: string;
          level: number;
          opened_at: number;
          exit_reason: string | null;
        }[];
        if (!rows.length) return { text: 'No incidents yet.', data: { incidents: [] } };
        const lines = rows.map(
          (r) =>
            `${r.profile} in the ${r.zone.replace(/_/g, ' ')}, ${ago(now() - r.opened_at)}, ${r.status === 'active' ? 'still active' : `ended: ${spokenExit(r.exit_reason, r.status)}`}.`,
        );
        return { text: lines.join(' '), data: { incidents: rows } };
      },
    },
    {
      name: 'stand_down',
      title: 'Stand down',
      description:
        'Stop the active incident: everything Quiet Porch turned on is turned off. Owner only.',
      inputSchema: {
        type: 'object',
        properties: { incident_id: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      role: 'owner',
      run: async (args) => {
        const id = args.incident_id !== undefined ? Number(args.incident_id) : active()?.id;
        if (!id) return { text: 'Nothing to stand down. All quiet.', data: { result: 'none' } };
        const r = await deps.standDown(id, 'mcp');
        return r === 'stopped'
          ? { text: 'Done. Everything has been turned off.', data: { result: r, incident_id: id } }
          : { text: 'That incident had already ended.', data: { result: r, incident_id: id } };
      },
    },
    {
      name: 'set_mode',
      title: 'Set house mode',
      description:
        'Set the house mode: home, away, or night. Away and night allow the higher deterrent levels. Owner only.',
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['home', 'away', 'night'] } },
        required: ['mode'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      role: 'owner',
      run: (args) => {
        const m = args.mode;
        if (m !== 'home' && m !== 'away' && m !== 'night') {
          return { text: 'Mode must be home, away or night.', isError: true };
        }
        deps.mode.set(m);
        return { text: `Mode set to ${m}.`, data: { mode: m } };
      },
    },
    {
      name: 'clear_reconcile',
      title: 'Clear a device check',
      description:
        'Mark a device that is waiting for an owner check as checked, after you have looked at it. Owner only.',
      inputSchema: {
        type: 'object',
        properties: { row_id: { type: 'integer', minimum: 1 } },
        required: ['row_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      role: 'owner',
      run: (args) => {
        const ok = deps.clearReconcile(Number(args.row_id), 'mcp:owner');
        return ok
          ? { text: 'Cleared.', data: { cleared: true } }
          : { text: 'Nothing to clear with that id.', data: { cleared: false } };
      },
    },
    {
      name: 'get_night_report',
      title: 'What happened last night?',
      description:
        'The last armed night in one breath: how many events, how many were silent, and one sentence for each one that was handled.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      role: 'read',
      run: () => {
        if (!deps.night) return { text: 'The night window is not configured.', isError: true };
        const span = latestNightWindow(
          now(),
          deps.night.start,
          deps.night.end,
          deps.night.timezone,
        );
        const ledger = buildLedger(db, span, { source: deps.source });
        const report = nightReport(ledger, span, {
          ...deps.night,
          dryRun: deps.dryRun,
          isExterior: deps.isExterior,
          source: deps.source,
          sourceLabel: deps.sourceLabel,
        });
        return {
          text: report.text,
          data: {
            ...report,
            source: deps.source ?? 'clip',
            source_label: deps.sourceLabel ?? null,
            dry_run: deps.dryRun,
          },
        };
      },
    },
    {
      name: 'get_ledger',
      title: 'The night ledger',
      description:
        'Every event of the last armed night, one line each, with the Ring capture time, evidence age, level reached and why it stopped.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      role: 'read',
      run: () => {
        if (!deps.night) return { text: 'The night window is not configured.', isError: true };
        const span = latestNightWindow(
          now(),
          deps.night.start,
          deps.night.end,
          deps.night.timezone,
        );
        const ledger = buildLedger(db, span, { source: deps.source });
        const c = ledger.counts;
        return {
          text: `${c.events} events, ${c.silent} silent, ${c.handled} handled.`,
          data: {
            window: { from: span.from, to: span.to, in_progress: span.inProgress },
            timezone: deps.night.timezone,
            source: deps.source ?? 'clip',
            source_label: deps.sourceLabel ?? null,
            dry_run: deps.dryRun,
            counts: c,
            lines: ledger.lines,
            text_lines: formatLedger(ledger.lines, deps.night.timezone),
          },
        };
      },
    },
    {
      name: 'expect_me',
      title: "I'm stepping out",
      description:
        'Tell Quiet Porch a person at the door is expected for a bounded time, so it stays quiet and records why. At most 60 minutes; pass cancel true to end the window. Owner only.',
      inputSchema: {
        type: 'object',
        properties: {
          person_label: { type: 'string', maxLength: 40 },
          minutes: {
            type: 'integer',
            minimum: 1,
            maximum: EXPECT_MAX_MINUTES,
            default: EXPECT_DEFAULT_MINUTES,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      role: 'owner',
      run: (args) => {
        const known = new Set(['person_label', 'minutes', 'cancel']);
        const stray = Object.keys(args).find((k) => !known.has(k));
        if (stray) return { text: `I do not know the argument ${stray}.`, isError: true };
        if (args.cancel === true) {
          const n = deps.cancelExpectation('mcp:owner');
          return {
            text: n ? 'Okay. I will watch for visitors again.' : 'There was no window to cancel.',
            data: { cancelled: n },
          };
        }
        if (args.cancel !== undefined) return { text: 'Cancel must be true.', isError: true };
        const m = args.minutes;
        if (
          m !== undefined &&
          !(typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= EXPECT_MAX_MINUTES)
        ) {
          return {
            text: `Minutes must be a whole number from 1 to ${EXPECT_MAX_MINUTES}.`,
            isError: true,
          };
        }
        if (args.person_label !== undefined && typeof args.person_label !== 'string') {
          return { text: 'The label must be text.', isError: true };
        }
        const label = cleanLabel(args.person_label);
        const e = deps.expectMe(label, m, 'mcp:owner');
        const mins = Math.round((e.expires_at - e.created_at) / 60_000);
        return {
          text: `Okay. I will stay quiet about ${label} for ${mins} minutes, and note each time.`,
          data: { expectation: e },
        };
      },
    },
  ];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body?: unknown, headers: object = {}) {
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

export function createStatusMcp(deps: StatusDeps) {
  const tools = createStatusTools(deps);
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handleRpc(msg: Record<string, unknown>, role: Role): Promise<unknown> {
    const id = msg.id;
    const method = msg.method;
    if (msg.jsonrpc !== '2.0' || typeof method !== 'string') {
      return rpcError(id, -32600, 'Invalid Request');
    }
    if (id === undefined) return undefined; // notification: nothing to answer
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'quiet-porch-status', title: 'Quiet Porch', version: '0.1.0' },
            instructions:
              'Home deterrent status for one house. Use get_incident_status for "is everything okay" and get_night_report for "what happened last night". stand_down, set_mode and expect_me need the owner token.',
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
              name,
              title,
              description,
              inputSchema,
              annotations,
            })),
          },
        };
      case 'tools/call': {
        const tool = byName.get(String(params.name));
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
        if (tool.role === 'owner' && role !== 'owner') {
          deps.log(`mcp: ${tool.name} refused for a read token`);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'That needs the owner. I can only report status.' }],
              isError: true,
            },
          };
        }
        if (
          params.arguments !== undefined &&
          (typeof params.arguments !== 'object' ||
            params.arguments === null ||
            Array.isArray(params.arguments))
        ) {
          return rpcError(id, -32602, 'arguments must be an object');
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const r = await tool.run(args);
          deps.log(`mcp: ${tool.name} by ${role}${r.isError ? ' (error)' : ''}`);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: r.text }],
              ...(r.data ? { structuredContent: r.data } : {}),
              ...(r.isError ? { isError: true } : {}),
            },
          };
        } catch (e) {
          deps.log(`mcp: ${tool.name} FAILED ${(e as Error).message}`);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'Something went wrong.' }], isError: true },
          };
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // The simulated Alexa+ page holds no secret: the viewer pastes a token into it.
      if (req.method === 'GET' && url.pathname === '/alexa') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(ALEXA_SIM_HTML);
      }
      if (req.method === 'GET' && url.pathname === '/ledger') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(LEDGER_HTML);
      }
      if (url.pathname !== '/mcp') return json(res, 404, { error: 'not found' });
      // DNS-rebinding guard (spec: servers MUST validate Origin when present).
      const origin = req.headers.origin;
      if (origin && !deps.allowedOrigins.includes(origin))
        return json(res, 403, { error: 'origin' });
      const role = tokenRole(req.headers.authorization, deps.tokens);
      if (!role) {
        return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      }
      if (req.method === 'GET') return json(res, 405, undefined, { Allow: 'POST' });
      if (req.method === 'DELETE') return json(res, 405, undefined, { Allow: 'POST' });
      if (req.method !== 'POST') return json(res, 405, undefined, { Allow: 'POST' });
      const pv = req.headers['mcp-protocol-version'];
      if (typeof pv === 'string' && !PROTOCOL_VERSIONS.includes(pv)) {
        return json(res, 400, rpcError(null, -32600, `Unsupported protocol version ${pv}`));
      }
      let msg: unknown;
      try {
        msg = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, rpcError(null, -32700, 'Parse error'));
      }
      if (Array.isArray(msg) || !msg || typeof msg !== 'object') {
        return json(res, 400, rpcError(null, -32600, 'Invalid Request'));
      }
      const out = await handleRpc(msg as Record<string, unknown>, role);
      if (out === undefined) return json(res, 202);
      return json(res, 200, out);
    } catch (e) {
      deps.log(`mcp: error ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, rpcError(null, -32603, 'Internal error'));
    }
  });

  return { server, tools };
}
