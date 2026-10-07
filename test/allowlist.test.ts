import { describe, expect, it } from 'vitest';
import {
  checkAction,
  classOf,
  loadAllowlist,
  parseAllowlist,
  type Allowlist,
  type EntityRule,
} from '../src/allowlist.ts';

const example = loadAllowlist(
  new URL('../config/allowlist.example.json', import.meta.url).pathname,
);

function entity(overrides: Record<string, unknown>) {
  return {
    entity_id: 'light.porch',
    placement: 'exterior',
    zones: ['front'],
    services: { turn_on: {}, turn_off: {} },
    ...overrides,
  };
}

describe('allowlist load-time rules', () => {
  it('loads the example config', () => {
    expect(example.entities.size).toBe(4);
  });
  it('rejects lock, cover and alarm entities even if listed', () => {
    for (const id of ['lock.front_door', 'cover.garage_door', 'alarm_control_panel.home']) {
      expect(() => parseAllowlist({ entities: [entity({ entity_id: id })] })).toThrow(
        /never allowed/,
      );
    }
  });
  it('requires a safety service on every entity', () => {
    expect(() => parseAllowlist({ entities: [entity({ services: { turn_on: {} } })] })).toThrow(
      /safety service/,
    );
  });
  it('rejects audio services on an interior media player', () => {
    const tv = entity({
      entity_id: 'media_player.tv',
      placement: 'interior',
      zones: [],
      services: { play_media: {}, turn_off: {} },
    });
    expect(() => parseAllowlist({ entities: [tv] })).toThrow(/interior media player/);
  });
  it('rejects an exterior entity with no zone, a duplicate, and a malformed param rule', () => {
    expect(() => parseAllowlist({ entities: [entity({ zones: [] })] })).toThrow(/zone/);
    expect(() => parseAllowlist({ entities: [entity({}), entity({})] })).toThrow(/duplicate/);
    const bad = entity({ services: { turn_on: { params: { brightness_pct: {} } }, turn_off: {} } });
    expect(() => parseAllowlist({ entities: [bad] })).toThrow(/min,max/);
  });
});

describe('checkAction', () => {
  it('allows a bounded escalation and classifies it', () => {
    expect(
      checkAction(example, {
        entity_id: 'light.front_spotlight',
        service: 'turn_on',
        data: { brightness_pct: 80 },
      }),
    ).toEqual({ ok: true, cls: 'escalation' });
  });
  it('classifies off/stop as safety', () => {
    expect(
      checkAction(example, { entity_id: 'light.front_spotlight', service: 'turn_off' }),
    ).toEqual({
      ok: true,
      cls: 'safety',
    });
    expect(classOf('media_stop')).toBe('safety');
    expect(classOf('turn_on')).toBe('escalation');
  });
  it('rejects out-of-range, non-numeric, unknown and off-enum parameters', () => {
    const spot = { entity_id: 'light.front_spotlight', service: 'turn_on' };
    expect(checkAction(example, { ...spot, data: { brightness_pct: 101 } }).ok).toBe(false);
    expect(checkAction(example, { ...spot, data: { brightness_pct: '80' } }).ok).toBe(false);
    expect(checkAction(example, { ...spot, data: { flash: 'long' } }).ok).toBe(false);
    const speaker = { entity_id: 'media_player.porch_speaker', service: 'play_media' };
    expect(
      checkAction(example, { ...speaker, data: { media_content_id: 'http://evil/siren.mp3' } }).ok,
    ).toBe(false);
  });
  it('rejects entities and services not listed, and forbidden domains', () => {
    expect(checkAction(example, { entity_id: 'light.garage', service: 'turn_on' }).ok).toBe(false);
    expect(checkAction(example, { entity_id: 'light.front_spotlight', service: 'toggle' }).ok).toBe(
      false,
    );
    expect(checkAction(example, { entity_id: 'lock.front_door', service: 'unlock' })).toEqual({
      ok: false,
      reason: 'domain lock forbidden',
    });
  });
  it('keeps the interior TV silent: mute only to true, no audio services', () => {
    const tv = { entity_id: 'media_player.living_room_tv' };
    expect(
      checkAction(example, { ...tv, service: 'volume_mute', data: { is_volume_muted: true } }).ok,
    ).toBe(true);
    expect(
      checkAction(example, { ...tv, service: 'volume_mute', data: { is_volume_muted: false } }).ok,
    ).toBe(false);
    expect(checkAction(example, { ...tv, service: 'play_media' }).ok).toBe(false);
    expect(checkAction(example, { ...tv, service: 'volume_up' }).ok).toBe(false);
  });
  it('denies interior audio at check time even if a rule slipped past the loader', () => {
    const tv: EntityRule = {
      entity_id: 'media_player.den_tv',
      placement: 'interior',
      zones: [],
      services: { play_media: {}, turn_off: {} },
    };
    const handBuilt: Allowlist = { entities: new Map([[tv.entity_id, tv]]) };
    expect(checkAction(handBuilt, { entity_id: tv.entity_id, service: 'play_media' })).toEqual({
      ok: false,
      reason: 'play_media denied on interior media player',
    });
  });
});

describe('bounded setters and pi_audio (plan v7 section 8)', () => {
  const valve = {
    entity_id: 'valve.front_yard_sprinkler_valve',
    placement: 'exterior',
    zones: ['front_yard'],
    services: { open_valve: {}, close_valve: {} },
  };
  const setter = (over: Record<string, unknown> = {}) => ({
    entity_id: 'number.front_yard_sprinkler_irrigation_duration',
    placement: 'exterior',
    zones: ['front_yard'],
    services: { set_value: { params: { value: { min: 5, max: 30 } } } },
    cleanup_via: 'valve.front_yard_sprinkler_valve',
    ...over,
  });

  it('a setter without cleanup_via fails to load (no safety service)', () => {
    expect(() => parseAllowlist({ entities: [valve, setter({ cleanup_via: undefined })] })).toThrow(
      /safety service/,
    );
  });
  it('a setter whose cleanup_via is missing or cannot close fails to load', () => {
    expect(() => parseAllowlist({ entities: [setter()] })).toThrow(/missing/);
    const noClose = { ...valve, services: { open_valve: {}, turn_off: {} } };
    expect(() => parseAllowlist({ entities: [noClose, setter()] })).toThrow(/lacks close_valve/);
  });
  it('set_value is bounded to 5..30 and is an escalation command', () => {
    const a = parseAllowlist({ entities: [valve, setter()] });
    const req = (value: number) => ({
      entity_id: 'number.front_yard_sprinkler_irrigation_duration',
      service: 'set_value',
      data: { value },
    });
    expect(checkAction(a, req(30))).toEqual({ ok: true, cls: 'escalation' });
    expect(checkAction(a, req(31)).ok).toBe(false);
    expect(classOf('set_value')).toBe('escalation');
  });
  it('the shipped allowlist loads; pi_audio rejects a clip outside its enum', () => {
    const shipped = loadAllowlist(new URL('../config/allowlist.json', import.meta.url).pathname);
    const play = (clip: string) =>
      checkAction(shipped, {
        entity_id: 'pi_audio.porch_speaker',
        service: 'play_clip',
        data: { clip },
      });
    expect(play('bark-5s')).toEqual({ ok: true, cls: 'escalation' });
    expect(play('never-gonna').ok).toBe(false);
    expect(checkAction(shipped, { entity_id: 'pi_audio.porch_speaker', service: 'stop' })).toEqual({
      ok: true,
      cls: 'safety',
    });
  });
});
