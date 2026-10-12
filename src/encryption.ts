// Encryption guard (F12). Ring documents `data.attributes.e2e_encryption.enabled` (a boolean) on
// GET /v1/devices/{id}/configurations, and says video requests for an encrypted device still
// succeed but return content the app cannot read. So an encrypted camera must never be treated
// as a camera that saw nothing: it is "blind", the ledger says so, and no frame is requested.
//
// Fail-open on purpose when the configuration cannot be read (state "unknown"): the pipeline
// still refuses any "frame" that is not JPEG bytes (frames.ts), so unreadable video cannot be
// judged, and the refusal shows in the ledger as "no frame".
//
// Not built: the switch to the Playground sandbox. Its base URL and token flow are not in
// Ring's api-documentation.html (read 2026-10-11), so sourceMode() only reports that a switch
// is needed; docs/friction-log.md lists it as a gap.

export type DeviceVideo = 'readable' | 'blind' | 'unknown';

export interface DeviceState {
  account_id: string;
  device_id: string;
  video: DeviceVideo;
  checked_at: number;
  http_status: number;
  request_id?: string;
}

// Only an explicit boolean counts. A missing field is "unknown", never "readable by default".
export function assessConfiguration(status: number, body: unknown): DeviceVideo {
  if (status !== 200) return 'unknown';
  const enabled = (body as { data?: { attributes?: { e2e_encryption?: { enabled?: unknown } } } })
    ?.data?.attributes?.e2e_encryption?.enabled;
  if (enabled === true) return 'blind';
  if (enabled === false) return 'readable';
  return 'unknown';
}

export interface FrictionRecord {
  ts: number;
  endpoint: string;
  device_id: string;
  http_status: number;
  request_id?: string;
  finding: string;
  workaround: string;
}

export interface GuardDeps {
  devices: () => Promise<{ accountId: string; deviceId: string }[]>;
  fetchConfig: (
    accountId: string,
    deviceId: string,
  ) => Promise<{ status: number; body?: unknown; requestId?: string }>;
  friction: (r: FrictionRecord) => void;
  log: (msg: string) => void;
  now?: () => number;
}

export function createSourceGuard(deps: GuardDeps) {
  const now = deps.now ?? Date.now;
  const states = new Map<string, DeviceState>();

  let running: Promise<void> | undefined;

  // Overlapping calls share one run, so a slow refresh cannot overwrite a newer one.
  function refresh(): Promise<void> {
    running ??= run().finally(() => (running = undefined));
    return running;
  }

  async function run(): Promise<void> {
    let list: { accountId: string; deviceId: string }[];
    try {
      list = await deps.devices();
    } catch (e) {
      deps.log(`encryption: device list failed (${(e as Error).message}); states unchanged`);
      return;
    }
    for (const d of list) {
      let res: Awaited<ReturnType<GuardDeps['fetchConfig']>>;
      try {
        res = await deps.fetchConfig(d.accountId, d.deviceId);
      } catch (e) {
        res = { status: 0, body: { error: (e as Error).message } };
      }
      const read = assessConfiguration(res.status, res.body);
      const prev = states.get(d.deviceId)?.video;
      // One failed read (HTTP 500, timeout) must not turn a blind camera readable for half an
      // hour: blind stays blind until a read says readable.
      const video = prev === 'blind' && read === 'unknown' ? 'blind' : read;
      states.set(d.deviceId, {
        account_id: d.accountId,
        device_id: d.deviceId,
        video,
        checked_at: now(),
        http_status: res.status,
        request_id: res.requestId,
      });
      // One friction line per change (and the first reading), not one per poll.
      if (video !== prev) {
        deps.friction({
          ts: now(),
          endpoint: 'GET /v1/devices/{device_id}/configurations',
          device_id: d.deviceId,
          http_status: res.status,
          request_id: res.requestId,
          finding:
            video === 'blind'
              ? 'e2e_encryption.enabled is true: video requests succeed but return unreadable content'
              : video === 'readable'
                ? 'e2e_encryption.enabled is false: video readable'
                : `e2e_encryption not readable (HTTP ${res.status}); treated as unknown`,
          workaround:
            video === 'blind'
              ? 'no frame requested; events from this device are ledger lines marked blind'
              : video === 'unknown'
                ? 'frames still must be JPEG bytes (frames.ts); unreadable video is refused as "no frame"'
                : 'none needed',
        });
        deps.log(`encryption: ${d.deviceId} is ${video}`);
      }
    }
  }

  const blindIds = () =>
    [...states.values()].filter((s) => s.video === 'blind').map((s) => s.device_id);
  return {
    refresh,
    isBlind: (deviceId: string) => states.get(deviceId)?.video === 'blind',
    blindDevices: blindIds,
    states: () => [...states.values()],
    // 'sandbox_needed' when every device we know is blind: a real night would be all blind.
    sourceMode: (): 'real' | 'sandbox_needed' | 'unknown' => {
      if (states.size === 0) return 'unknown';
      return blindIds().length === states.size ? 'sandbox_needed' : 'real';
    },
  };
}

export type SourceGuard = ReturnType<typeof createSourceGuard>;
