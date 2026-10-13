import { approvedSpeech } from './voice.ts';
// Actuator allowlist (plan v6 items 5 and 7). Every Home Assistant call the coordinator makes is
// checked here first. Rules that must not depend on config are fixed in code:
//   - lock, cover (garage doors live here) and alarm_control_panel are rejected at load and check;
//   - a service's class (safety vs escalation) is derived from its name, never from config;
//   - interior media players can never take audio-producing services;
//   - every entity must expose at least one safety service, so cleanup is always possible; a
//     bounded setter (plan v7 section 8) instead names a cleanup_via entity that can close;
//   - pi_audio.* entities are the Pi speaker (no HA state), checked by the same gate.
// The Ring chime playback endpoint is not an HA service, so it has no path through this module.
import { readFileSync } from 'node:fs';

export type Placement = 'exterior' | 'interior';
export type CommandClass = 'safety' | 'escalation';

export type ParamRule =
  { maxLength: number } | { min: number; max: number } | { enum: (string | number | boolean)[] };

export interface EntityRule {
  entity_id: string;
  placement: Placement;
  zones: string[];
  services: Record<string, { params?: Record<string, ParamRule> }>;
  // Setter only (e.g. an irrigation duration): the entity its cleanup and boot sweep act on.
  cleanup_via?: string;
}

export interface Allowlist {
  entities: Map<string, EntityRule>;
}

export interface ActionRequest {
  zone?: string; // required for exterior escalation, never for safety cleanup
  entity_id: string;
  service: string;
  data?: Record<string, unknown>;
}

export type ActionCheck = { ok: true; cls: CommandClass } | { ok: false; reason: string };

export const FORBIDDEN_DOMAINS = new Set(['lock', 'cover', 'alarm_control_panel']);

// Services that only stop, close, or silence. Safety commands bypass evidence guards in the
// coordinator, so this set must never contain anything that turns something on or makes sound.
export const SAFETY_SERVICES = new Set([
  'turn_off',
  'close_valve',
  'media_stop',
  'media_pause',
  'stop',
  'cancel',
]);

// What cleanup sends to each entity, by domain. Every value is in SAFETY_SERVICES.
export const CLEANUP_SERVICE: Record<string, string> = {
  light: 'turn_off',
  switch: 'turn_off',
  valve: 'close_valve',
  media_player: 'media_stop',
  pi_audio: 'stop',
};

// Sound-producing media_player services, denied on interior entities whatever config says.
export const INTERIOR_AUDIO_DENY = new Set([
  'play_media',
  'media_play',
  'media_play_pause',
  'volume_set',
  'volume_up',
  'select_source',
]);

export function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot) : '';
}

export function classOf(service: string): CommandClass {
  return SAFETY_SERVICES.has(service) ? 'safety' : 'escalation';
}

function isInteriorAudio(rule: { placement: Placement; entity_id: string }, service: string) {
  return (
    rule.placement === 'interior' &&
    domainOf(rule.entity_id) === 'media_player' &&
    INTERIOR_AUDIO_DENY.has(service)
  );
}

function validateRule(raw: unknown, index: number): EntityRule {
  const where = `allowlist entities[${index}]`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: not an object`);
  const r = raw as Partial<EntityRule>;
  if (typeof r.entity_id !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(r.entity_id)) {
    throw new Error(`${where}: bad entity_id`);
  }
  const at = `${where} (${r.entity_id})`;
  if (FORBIDDEN_DOMAINS.has(domainOf(r.entity_id))) {
    throw new Error(`${at}: domain ${domainOf(r.entity_id)} is never allowed`);
  }
  if (r.placement !== 'exterior' && r.placement !== 'interior') {
    throw new Error(`${at}: placement must be exterior or interior`);
  }
  if (!Array.isArray(r.zones) || r.zones.some((z) => typeof z !== 'string')) {
    throw new Error(`${at}: zones must be a string array`);
  }
  if (r.placement === 'exterior' && r.zones.length === 0) {
    throw new Error(`${at}: exterior entity needs at least one zone`);
  }
  if (!r.services || typeof r.services !== 'object') throw new Error(`${at}: services missing`);
  const names = Object.keys(r.services);
  if (r.cleanup_via !== undefined) {
    if (typeof r.cleanup_via !== 'string') throw new Error(`${at}: cleanup_via must be a string`);
    if (names.some((s) => SAFETY_SERVICES.has(s))) {
      throw new Error(`${at}: a setter takes no safety service; cleanup goes through cleanup_via`);
    }
  } else if (!names.some((s) => SAFETY_SERVICES.has(s))) {
    throw new Error(
      `${at}: needs at least one safety service (${[...SAFETY_SERVICES].join(', ')})`,
    );
  }
  for (const s of names) {
    if (isInteriorAudio(r as EntityRule, s)) {
      throw new Error(`${at}: ${s} is an audio service on an interior media player`);
    }
    for (const [p, rule] of Object.entries(r.services[s]?.params ?? {})) {
      const okRange = 'min' in rule && 'max' in rule && rule.min <= rule.max;
      const okEnum = 'enum' in rule && Array.isArray(rule.enum) && rule.enum.length > 0;
      const okText =
        'maxLength' in rule &&
        Number.isInteger(rule.maxLength) &&
        rule.maxLength > 0 &&
        rule.maxLength <= 240;
      if (!okRange && !okEnum && !okText)
        throw new Error(`${at}: ${s}.${p} needs {min,max} or {enum}`);
    }
  }
  return r as EntityRule;
}

export function parseAllowlist(json: unknown): Allowlist {
  const list = (json as { entities?: unknown })?.entities;
  if (!Array.isArray(list)) throw new Error('allowlist: entities array missing');
  const entities = new Map<string, EntityRule>();
  list.forEach((raw, i) => {
    const rule = validateRule(raw, i);
    if (entities.has(rule.entity_id)) throw new Error(`allowlist: duplicate ${rule.entity_id}`);
    entities.set(rule.entity_id, rule);
  });
  for (const rule of entities.values()) {
    if (rule.cleanup_via === undefined) continue;
    const target = entities.get(rule.cleanup_via);
    if (!target)
      throw new Error(`allowlist: ${rule.entity_id} cleanup_via ${rule.cleanup_via} missing`);
    if (!target.services.close_valve) {
      throw new Error(
        `allowlist: ${rule.entity_id} cleanup_via ${rule.cleanup_via} lacks close_valve`,
      );
    }
  }
  return { entities };
}

export function loadAllowlist(path: string): Allowlist {
  return parseAllowlist(JSON.parse(readFileSync(path, 'utf8')));
}

export function checkAction(allowlist: Allowlist, req: ActionRequest): ActionCheck {
  const domain = domainOf(req.entity_id);
  if (FORBIDDEN_DOMAINS.has(domain)) return { ok: false, reason: `domain ${domain} forbidden` };
  const rule = allowlist.entities.get(req.entity_id);
  if (!rule) return { ok: false, reason: `${req.entity_id} not in allowlist` };
  if (isInteriorAudio(rule, req.service)) {
    return { ok: false, reason: `${req.service} denied on interior media player` };
  }
  if (
    classOf(req.service) === 'escalation' &&
    rule.placement === 'exterior' &&
    (!req.zone || !rule.zones.includes(req.zone))
  ) {
    return { ok: false, reason: `${req.entity_id}: incident zone not allowed` };
  }
  const svc = rule.services[req.service];
  if (!svc) return { ok: false, reason: `${req.entity_id}: service ${req.service} not allowed` };
  const params = svc.params ?? {};
  for (const [key, value] of Object.entries(req.data ?? {})) {
    const pr = params[key];
    if (!pr) return { ok: false, reason: `${req.service}: parameter ${key} not allowed` };
    if ('enum' in pr) {
      if (!pr.enum.includes(value as string | number | boolean)) {
        return { ok: false, reason: `${req.service}: ${key}=${String(value)} not in enum` };
      }
    } else if ('maxLength' in pr) {
      if (typeof value !== 'string' || value.length > pr.maxLength)
        return { ok: false, reason: 'invalid bounded text' };
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: `${req.service}: ${key} must be a number` };
    } else if (value < pr.min || value > pr.max) {
      return {
        ok: false,
        reason: `${req.service}: ${key}=${value} outside [${pr.min}, ${pr.max}]`,
      };
    }
  }
  if (
    req.service === 'speak' &&
    !approvedSpeech(req.data?.spoken_text as string, req.data?.owner_notified === true)
  )
    return { ok: false, reason: 'speech outside approved template' };
  return { ok: true, cls: classOf(req.service) };
}
