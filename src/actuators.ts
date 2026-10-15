// Action adapters (plan v7 section 8). The coordinator talks to these interfaces only; which
// implementation it gets is decided once, in createActuators, from the dry-run flag:
//   - dry run: a simulator that records "would call" and keeps a fake state per entity, so the
//     read-back gates (duration = 30 before open, valve closed at +40 s) run end to end;
//   - live: HA REST, pi_audio over ssh, and Telegram. createActuators refuses to build them
//     while the pipeline config is a dry run, and parsePipelineConfig refuses anything else.
import { execFile } from 'node:child_process';
import type { createSpeechOutput } from './speech.ts';
import { domainOf } from './allowlist.ts';

export type CallResult =
  | { ok: true; contextId?: string; spokenText?: string; fallback?: boolean; latencyMs?: number }
  | { ok: false; error: string };

export interface Actuator {
  call(req: {
    intentId: string;
    entity_id: string;
    service: string;
    data?: Record<string, unknown>;
    dispatchEpochMs: number;
  }): Promise<CallResult>;
  // Current state as HA reports it ('on', 'off', 'open', 'closed', '30', ...); for pi_audio,
  // 'playing' or 'idle'. Undefined when it cannot be read.
  readState(entity_id: string): Promise<string | undefined>;
}

export interface Notification {
  incidentId: number;
  text: string;
  frame?: Buffer;
  stopUrl?: string;
}

export interface Notifier {
  send(n: Notification): Promise<void>;
}

export interface Actuators {
  ha: Actuator;
  audio: Actuator;
  notifier: Notifier;
  live: boolean;
}

export function actuatorFor(a: Actuators, entityId: string): Actuator {
  return domainOf(entityId) === 'pi_audio' ? a.audio : a.ha;
}

// ---- dry run ----

export interface DryRunLog {
  (rec: { kind: 'call' | 'notify'; [k: string]: unknown }): void;
}

// Simulated devices: enough behavior for the coordinator's read-backs to mean something.
// The valve closes itself after the simulated irrigation duration, like the real device should.
export function createDryRunActuators(log: DryRunLog, clock: { now(): number } = Date): Actuators {
  const state = new Map<string, string>();
  const valveOpenedAt = new Map<string, { at: number; seconds: number }>();
  // HA's Tuya naming: a single-outlet timer has valve.X_valve / number.X_irrigation_duration, a
  // multi-outlet one valve.X_valve_N / number.X_irrigation_duration_N.
  const durationFor = (valve: string) => {
    const setter = valve.replace(/^valve\.(.*)_valve(_\d+)?$/, 'number.$1_irrigation_duration$2');
    return Number(state.get(setter) ?? '0');
  };
  const read = (entity: string): string | undefined => {
    const run = valveOpenedAt.get(entity);
    if (run && clock.now() - run.at >= run.seconds * 1000) {
      valveOpenedAt.delete(entity);
      state.set(entity, 'closed');
    }
    return state.get(entity) ?? (domainOf(entity) === 'pi_audio' ? 'idle' : 'off');
  };
  const sim: Actuator = {
    async call({ intentId, entity_id, service, data }) {
      log({ kind: 'call', intent_id: intentId, entity_id, service, data: data ?? {} });
      switch (service) {
        case 'turn_on':
          state.set(entity_id, 'on');
          break;
        case 'turn_off':
          state.set(entity_id, 'off');
          break;
        case 'set_value':
          state.set(entity_id, String(data?.value));
          break;
        case 'open_valve': {
          const seconds = durationFor(entity_id);
          state.set(entity_id, 'open');
          if (seconds > 0) valveOpenedAt.set(entity_id, { at: clock.now(), seconds });
          break;
        }
        case 'close_valve':
          valveOpenedAt.delete(entity_id);
          state.set(entity_id, 'closed');
          break;
        case 'speak':
        case 'play_clip':
          state.set(entity_id, 'playing');
          break;
        case 'stop':
        case 'media_stop':
          state.set(entity_id, 'idle');
          break;
      }
      return { ok: true };
    },
    async readState(entity_id) {
      return read(entity_id);
    },
  };
  return {
    ha: sim,
    audio: sim,
    live: false,
    notifier: {
      async send(n) {
        log({
          kind: 'notify',
          incident_id: n.incidentId,
          text: `[dry run, would send] ${n.text}`,
          has_frame: !!n.frame,
          stop_url: n.stopUrl ? 'present' : 'absent',
        });
      },
    },
  };
}

// ---- live: Home Assistant REST ----

type FetchFn = typeof fetch;

export function createHaActuator(opts: {
  baseUrl: string;
  token: string;
  fetchFn?: FetchFn;
  deadlineMs?: number;
}): Actuator {
  const f = opts.fetchFn ?? fetch;
  const deadline = opts.deadlineMs ?? 3000;
  const headers = { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' };
  return {
    async call({ entity_id, service, data }) {
      const domain = domainOf(entity_id);
      try {
        const res = await f(`${opts.baseUrl}/api/services/${domain}/${service}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ entity_id, ...(data ?? {}) }),
          signal: AbortSignal.timeout(deadline),
        });
        if (!res.ok) return { ok: false, error: `http_${res.status}` };
        // HA returns the states that changed; take the context only from our entity's state.
        const changed = (await res.json().catch(() => [])) as {
          entity_id?: string;
          context?: { id?: string };
        }[];
        const mine = Array.isArray(changed)
          ? changed.find((s) => s.entity_id === entity_id)
          : undefined;
        return { ok: true, contextId: mine?.context?.id };
      } catch (e) {
        return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network' };
      }
    },
    async readState(entity_id) {
      try {
        const res = await f(`${opts.baseUrl}/api/states/${entity_id}`, {
          headers,
          signal: AbortSignal.timeout(deadline),
        });
        if (!res.ok) return undefined;
        return ((await res.json()) as { state?: string }).state;
      } catch {
        return undefined;
      }
    },
  };
}

// ---- live: Pi speaker over ssh (qp-play / qp-stop / qp-status in scripts/pi/) ----

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export const realExec: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    ),
  );

export const CLIP_RE = /^[a-z0-9-]{1,32}$/;

export function createPiAudioActuator(opts: {
  host: string;
  speech?: ReturnType<typeof createSpeechOutput>;
  exec?: ExecFn;
  deadlineMs?: number;
}): Actuator {
  const exec = opts.exec ?? realExec;
  const deadline = opts.deadlineMs ?? 3000;
  const ssh = (remote: string[]) =>
    exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', opts.host, ...remote], deadline);
  return {
    async call({ intentId, service, data, dispatchEpochMs }) {
      try {
        if (service === 'speak') {
          if (!opts.speech) return { ok: false, error: 'speech_not_configured' };
          return opts.speech.speak(
            String(data?.spoken_text ?? ''),
            data?.owner_notified === true,
            intentId,
            dispatchEpochMs,
          );
        }
        if (service === 'play_clip') {
          const clip = String(data?.clip ?? '');
          // The allowlist enum already pinned the clip; this keeps the ssh argv inert anyway.
          if (!CLIP_RE.test(clip) || !/^[A-Za-z0-9-]+$/.test(intentId)) {
            return { ok: false, error: 'bad_argument' };
          }
          const out = await ssh(['qp-play', intentId, String(dispatchEpochMs), clip]);
          return out.trim().startsWith('started') ? { ok: true } : { ok: false, error: out.trim() };
        }
        if (service === 'stop') {
          const out = await ssh(['qp-stop', String(dispatchEpochMs)]);
          return out.trim() === 'stopped' ? { ok: true } : { ok: false, error: out.trim() };
        }
        return { ok: false, error: `unsupported_${service}` };
      } catch (e) {
        return { ok: false, error: (e as { killed?: boolean }).killed ? 'timeout' : 'ssh_failed' };
      }
    },
    async readState() {
      try {
        const out = (await ssh(['qp-status'])).trim();
        return out === 'playing' || out === 'idle' ? out : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

// ---- live: Telegram ----

export function createTelegramNotifier(opts: {
  token: string;
  chatId: string;
  fetchFn?: FetchFn;
}): Notifier {
  const f = opts.fetchFn ?? fetch;
  const api = (method: string) => `https://api.telegram.org/bot${opts.token}/${method}`;
  return {
    async send(n) {
      const markup = n.stopUrl
        ? JSON.stringify({ inline_keyboard: [[{ text: 'Stop', url: n.stopUrl }]] })
        : undefined;
      let res: Response;
      if (n.frame) {
        const form = new FormData();
        form.set('chat_id', opts.chatId);
        form.set('caption', n.text);
        form.set('photo', new Blob([new Uint8Array(n.frame)], { type: 'image/jpeg' }), 'frame.jpg');
        if (markup) form.set('reply_markup', markup);
        res = await f(api('sendPhoto'), { method: 'POST', body: form });
      } else {
        res = await f(api('sendMessage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: opts.chatId,
            text: n.text,
            ...(markup ? { reply_markup: JSON.parse(markup) } : {}),
          }),
        });
      }
      if (!res.ok) throw new Error(`telegram http_${res.status}`);
    },
  };
}

// ---- factory: the dry-run lock ----

export interface LiveSettings {
  haUrl: string;
  haToken: string;
  piHost: string;
  speech?: ReturnType<typeof createSpeechOutput>;
  telegramToken: string;
  telegramChatId: string;
}

export function createActuators(
  dryRun: boolean,
  log: DryRunLog,
  live?: () => LiveSettings,
): Actuators {
  if (dryRun) return createDryRunActuators(log);
  // Unreachable today: parsePipelineConfig refuses dryRun !== true. Kept explicit so turning on
  // a live run is a deliberate, reviewed change in two places, not a config edit.
  if (!live) throw new Error('live actuators requested without live settings');
  const s = live();
  return {
    ha: createHaActuator({ baseUrl: s.haUrl, token: s.haToken }),
    audio: createPiAudioActuator({ host: s.piHost, speech: s.speech }),
    notifier: createTelegramNotifier({ token: s.telegramToken, chatId: s.telegramChatId }),
    live: true,
  };
}

// Transfer finite, validated audio only. Calling this requires authorized Pi playback.
export function createPiSpeechPlayer(host: string, exec: ExecFn = realExec) {
  if (!/^[a-zA-Z0-9_.@-]+$/.test(host)) throw new Error('invalid_pi_host');
  return async (path: string, id: string, epoch: number) => {
    const name = path.split('/').at(-1)!;
    if (!/^speech-[a-f0-9]{64}\.wav$/.test(name) || !/^[A-Za-z0-9-]{1,64}$/.test(id))
      throw new Error('bad_audio_argument');
    await exec(
      'scp',
      ['-q', '-o', 'BatchMode=yes', path, `${host}:quiet-porch/clips/${name}`],
      2000,
    );
    if (Date.now() - epoch >= 3000) throw new Error('speech_expired');
    const result = await exec(
      'ssh',
      ['-o', 'BatchMode=yes', host, 'qp-speak', id, String(epoch), name.slice(0, -4)],
      2000,
    );
    if (!result.trim().startsWith('started')) throw new Error('pi_playback_refused');
  };
}
