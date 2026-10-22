// Labelled delivery replay: one recorded Ring person still stands in for the camera, so the
// real judgement, Telegram and Pi speaker can be exercised without a person on cue. It
// proves the delivery chain only. It never proves live wake, camera media or real dwell.
//
// Honesty rules: the single wake is synthesized and logged as such; every served frame is
// the same recorded still, stamped with the time it was requested and logged with its hash.
// The 6 s freshness gate is unchanged: a frame is ~2 s old when served, so slow judgement
// still fails exactly as it does live. Dwell built from a held still is a replay artifact.
import { createHash } from 'node:crypto';
import type { MotionWake } from './attended-source.ts';
import type { TestScope } from './attended-test.ts';
import type { ImageAttempt } from './ring.ts';

export function checkReplayFixture(image: Buffer, expectedSha256: string) {
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8)
    throw new Error('replay_fixture_not_jpeg');
  if (createHash('sha256').update(image).digest('hex') !== expectedSha256)
    throw new Error('replay_fixture_differs_from_approval');
}

export function createReplaySource(deps: {
  scope: TestScope;
  fixture: string;
  image: Buffer;
  audit: (row: Record<string, unknown>) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const sha = createHash('sha256').update(deps.image).digest('hex');
  let woken = false,
    served = 0;
  return {
    // One synthesized wake, on the first read only.
    readWakes(cursor: number): { after: number; wakes: MotionWake[] } {
      if (woken) return { after: cursor, wakes: [] };
      woken = true;
      const eventTs = now() - 500;
      deps.audit({ event: 'replay_wake_synthesized', fixture: deps.fixture, event_ts: eventTs });
      return {
        after: cursor,
        wakes: [
          {
            ...deps.scope,
            id: `replay-${deps.fixture}`,
            eventTs,
            subType: 'human',
            source: 'ring_event',
          },
        ],
      };
    },
    async download(
      accountId: string,
      deviceId: string,
      timestamp: number,
      options?: { keepImage?: boolean; signal?: AbortSignal },
    ): Promise<ImageAttempt> {
      options?.signal?.throwIfAborted();
      if (accountId !== deps.scope.accountId || deviceId !== deps.scope.deviceId)
        throw new Error('replay_scope_mismatch');
      served++;
      deps.audit({
        event: 'replay_frame_served',
        fixture: deps.fixture,
        served,
        requested_ts: timestamp,
        image_sha256: sha,
      });
      return {
        status: 200,
        step: 2,
        content_type: 'image/jpeg',
        bytes: deps.image.length,
        media_timestamp: timestamp,
        // The frame checks accept only recorded media; a replayed still is a recording.
        media_origin: 'recording',
        image: options?.keepImage ? deps.image : undefined,
      };
    },
    served: () => served,
  };
}
