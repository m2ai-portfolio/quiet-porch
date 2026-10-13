// Transport and provenance boundary. Decoder arrival time is never a Ring capture timestamp.
export interface LiveFrame {
  jpeg: Buffer;
  captureTs: number;
  timestampAuthority: 'ring' | 'arrival';
  accountId: string;
  deviceId: string;
}
export interface LiveSession {
  read(): Promise<LiveFrame | undefined>;
  close(): Promise<void>;
}
export interface LiveTransport {
  open(accountId: string, deviceId: string): Promise<LiveSession>;
}
export function createLiveSource(opts: {
  transport: LiveTransport;
  accountId: string;
  deviceId: string;
  battery: boolean;
  now: () => number;
  onStatus?: (state: string) => void;
}) {
  let session: LiveSession | undefined;
  let openedAt = 0;
  let newest: LiveFrame | undefined;
  let lastAcceptedTs: number | undefined;
  let stopped = false;
  let pending: Promise<LiveFrame | undefined> | undefined;
  const status = opts.onStatus ?? (() => {});
  async function bounded<T>(op: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      op,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('live_source_timeout')), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  async function pollInner() {
    if (stopped) return undefined;
    try {
      if (session && opts.now() - openedAt >= (opts.battery ? 30000 : 60000)) {
        await bounded(session.close());
        session = undefined;
      }
      if (!session) {
        const opening = opts.transport.open(opts.accountId, opts.deviceId);
        try {
          session = await bounded(opening);
        } catch (error) {
          // A transport that answers after the deadline still owns a session: close it.
          void opening.then((late) => bounded(late.close())).catch(() => {});
          throw error;
        }
        openedAt = opts.now();
      }
      const frame = await bounded(session.read());
      if (stopped) {
        await bounded(session.close());
        session = undefined;
        return undefined;
      }
      if (
        !frame ||
        frame.accountId !== opts.accountId ||
        frame.deviceId !== opts.deviceId ||
        frame.timestampAuthority !== 'ring' ||
        !Number.isFinite(frame.captureTs) ||
        frame.captureTs > opts.now() ||
        opts.now() - frame.captureTs >= 6000 ||
        (lastAcceptedTs !== undefined && frame.captureTs <= lastAcceptedTs) ||
        frame.jpeg[0] !== 255 ||
        frame.jpeg[1] !== 216
      ) {
        newest = undefined;
        status('clip: untrusted or stale live evidence');
        return undefined;
      }
      newest = frame;
      lastAcceptedTs = frame.captureTs;
      status('live: trusted capture timestamp');
      return frame;
    } catch {
      newest = undefined;
      const previous = session;
      session = undefined;
      if (previous) await bounded(previous.close()).catch(() => {});
      status('clip: live source unavailable');
      return undefined;
    }
  }
  return {
    poll() {
      pending ??= pollInner().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    latest() {
      return newest && opts.now() - newest.captureTs < 6000 ? newest : undefined;
    },
    async stop() {
      stopped = true;
      newest = undefined;
      await pending;
      if (session) await bounded(session.close()).catch(() => {});
      session = undefined;
      status('stopped');
    },
  };
}
// Ring endpoint/auth/SDP exchange; no decoder is invented here. A separately authorized probe
// must establish absolute capture-time provenance before supplying a trusted LiveTransport.
export function createWhepSignaling(opts: { token: () => string; fetchFn?: typeof fetch }) {
  const request = opts.fetchFn ?? fetch;
  return {
    async open(deviceId: string, offer: string) {
      const base = `https://api.amazonvision.com/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions`;
      const response = await request(base, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${opts.token()}`, 'Content-Type': 'application/sdp' },
        body: offer,
        signal: AbortSignal.timeout(3000),
      });
      if (response.status !== 201) throw new Error(`whep_http_${response.status}`);
      const location = new URL(response.headers.get('Location') ?? '', base);
      if (
        location.origin !== 'https://api.amazonvision.com' ||
        !location.pathname.startsWith(new URL(base).pathname + '/')
      )
        throw new Error('invalid_whep_session_location');
      const answer = await response.text();
      if (!answer.startsWith('v=0')) throw new Error('invalid_whep_sdp');
      return {
        answer,
        async close() {
          const r = await request(location, {
            method: 'DELETE',
            redirect: 'error',
            headers: { Authorization: `Bearer ${opts.token()}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!r.ok) throw new Error('whep_close_failed');
        },
      };
    },
  };
}
export function rtspsEndpoint(deviceId: string) {
  return `rtsps://video.rtsp.amazonvision.com:322/v1/devices/${encodeURIComponent(deviceId)}/stream`;
}
