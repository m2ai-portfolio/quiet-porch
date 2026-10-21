import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { checkReplayFixture, createReplaySource } from '../src/delivery-replay.ts';
import { runBoundedYard } from '../src/bounded-yard.ts';
import type { ContentBlock } from '../src/bedrock.ts';
import type { PipelineConfig } from '../src/pipeline.ts';

const scope = { accountId: 'fixture-owner', deviceId: 'fixture-camera', zone: 'front_yard' };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

it('accepts only the approved JPEG bytes', () => {
  expect(() => checkReplayFixture(jpeg, sha(jpeg))).not.toThrow();
  expect(() => checkReplayFixture(jpeg, sha(Buffer.from('other')))).toThrow(
    'replay_fixture_differs_from_approval',
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  expect(() => checkReplayFixture(png, sha(png))).toThrow('replay_fixture_not_jpeg');
});

it('synthesizes exactly one labelled wake and serves the still stamped at request time', async () => {
  const rows: Record<string, unknown>[] = [];
  const source = createReplaySource({
    scope,
    fixture: 'ring-door-person',
    image: jpeg,
    audit: (r) => rows.push(r),
    now: () => 50_000,
  });
  const first = source.readWakes(7);
  expect(first.wakes).toEqual([
    { ...scope, id: 'replay-ring-door-person', eventTs: 49_500, source: 'ring_event' },
  ]);
  expect(source.readWakes(7).wakes).toEqual([]);
  const frame = await source.download(scope.accountId, scope.deviceId, 48_000, { keepImage: true });
  expect(frame).toMatchObject({ status: 200, media_timestamp: 48_000, image: jpeg });
  const bare = await source.download(scope.accountId, scope.deviceId, 50_000);
  expect(bare.image).toBeUndefined();
  await expect(source.download('someone-else', scope.deviceId, 1)).rejects.toThrow(
    'replay_scope_mismatch',
  );
  expect(rows.filter((r) => r.event === 'replay_wake_synthesized')).toHaveLength(1);
  expect(rows.filter((r) => r.event === 'replay_frame_served')).toEqual([
    expect.objectContaining({ served: 1, requested_ts: 48_000, image_sha256: sha(jpeg) }),
    expect.objectContaining({ served: 2, requested_ts: 50_000 }),
  ]);
});

// The real one-encounter engine fed by the replay source, with mocked judgement and outputs.
function rig(modelLatencyMs = 300) {
  const t0 = Date.UTC(2026, 9, 22, 16, 0);
  let time = t0;
  const cfg: PipelineConfig = {
    dryRun: true,
    zones: { [scope.deviceId]: scope.zone },
    timezone: 'UTC',
    nightWindow: { start: '20:00', end: '06:30' },
    followUpProbe: false,
    wildlifeMaxEvidenceAgeMs: 35000,
    context: {
      mode: 'away',
      knownPets: [],
      expectedVisitors: [],
      routines: [],
      nuisanceSpecies: [],
    },
  };
  const rows: Record<string, unknown>[] = [];
  const source = createReplaySource({
    scope,
    fixture: 'ring-door-person',
    image: jpeg,
    audit: (r) => rows.push(r),
    now: () => time,
  });
  const outputs = {
    alert: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const converse = vi.fn(async (content: ContentBlock[]) => {
    time += modelLatencyMs;
    const text = content.map((c) => ('text' in c ? c.text : '')).join(' ');
    const id = text.match(/ev_[a-f0-9]{24}/)?.[0];
    return JSON.stringify(
      text.includes('independent visual critique')
        ? { evidence_id: id, verdict: 'unknown', person_present: true, reasons: ['fixture'] }
        : {
            evidence_id: id,
            subjects: [{ class: 'person', confidence: 0.99 }],
            person_present: true,
            activity: 'standing',
            night_ir: false,
          },
    );
  });
  const run = () =>
    runBoundedYard(
      {
        scope,
        modelId: 'fixture-model',
        region: 'fixture-region',
        config: () => cfg,
        authorized: () => true,
        killed: () => false,
        night: () => true,
        initialCooldown: 0,
        cursor: 0,
        readWakes: source.readWakes,
        download: source.download,
        converse: async (content) => converse(content),
        audit: (r) => rows.push(r),
        reserve: vi.fn(),
        now: () => time,
        mono: () => time - t0,
        sleep: async (ms) => {
          time += ms;
        },
      },
      { mode: 'attended_delivery', ready: async () => true, outputs },
    );
  return { run, rows, outputs, source, converse };
}

it('a replay reaches one Telegram alert and one speech through the real engine', async () => {
  const r = rig();
  const result = await r.run();
  expect(result).toMatchObject({
    reason: 'encounter_completed',
    safety_pass: true,
    alert_attempts: 1,
    speech_attempts: 1,
    transport_result: 'acknowledged',
  });
  expect(r.outputs.alert).toHaveBeenCalledTimes(1);
  expect(r.outputs.speak).toHaveBeenCalledTimes(1);
  expect(result.frames).toBe(r.source.served());
  expect(result.frames).toBeLessThanOrEqual(30);
  expect(result.model_calls).toBeLessThanOrEqual(60);
});

it('slow judgement of a replayed still is rejected as stale exactly as live: no output', async () => {
  const r = rig(2500); // two sequential-or-parallel calls push the result past 6 s
  const result = await r.run();
  expect(r.outputs.alert).not.toHaveBeenCalled();
  expect(r.outputs.speak).not.toHaveBeenCalled();
  expect(result.alert_attempts).toBe(0);
  expect(r.rows.some((row) => row.reason === 'model_result_stale')).toBe(true);
});

it('the replay CLI cannot reach the camera: no Ring client and no camera tokens', () => {
  const source = readFileSync(
    new URL('../scripts/deliver-replay-once.ts', import.meta.url),
    'utf8',
  );
  const runtime = readFileSync(new URL('../scripts/delivery-runtime.ts', import.meta.url), 'utf8');
  for (const text of [source, runtime]) {
    expect(text).not.toMatch(/from '\.\.\/src\/ring\.ts'/);
    expect(text).not.toMatch(/tokens\.json/);
    expect(text).not.toMatch(/downloadImageAt/);
  }
  expect(source).toMatch(/replayAlertText\(policy\.fixture, id\)/);
  const replayModule = readFileSync(new URL('../src/delivery-replay.ts', import.meta.url), 'utf8');
  expect(replayModule).toMatch(/^import type \{ ImageAttempt \} from '\.\/ring\.ts';$/m);
});
