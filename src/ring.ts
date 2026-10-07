// Ring (Amazon Vision) API client. Endpoints from Ring's api-documentation.html, read 2026-10-05.
export const RING_OAUTH_TOKEN_URL = 'https://oauth.ring.com/oauth/token';
export const RING_API = 'https://api.amazonvision.com';

const TIMEOUT_MS = 10_000;

export interface RingCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
  token_type: string;
}

export class RingApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(what: string, status: number, body: string) {
    super(`${what} failed: HTTP ${status} ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function call(what: string, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new RingApiError(what, res.status, text);
  return text ? JSON.parse(text) : {};
}

async function tokenGrant(what: string, params: Record<string, string>): Promise<TokenResponse> {
  const body = await call(what, RING_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const t = body as Partial<TokenResponse>;
  if (!t.access_token || !t.refresh_token || typeof t.expires_in !== 'number') {
    throw new Error(`${what}: token response missing access_token/refresh_token/expires_in`);
  }
  return t as TokenResponse;
}

export function exchangeCode(creds: RingCredentials, code: string): Promise<TokenResponse> {
  return tokenGrant('token exchange', {
    grant_type: 'authorization_code',
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
}

export function refreshTokens(
  creds: RingCredentials,
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenGrant('token refresh', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
}

export async function getAccountId(accessToken: string): Promise<string> {
  const body = (await call('GET /v1/users/me', `${RING_API}/v1/users/me`, {
    headers: bearer(accessToken),
  })) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error('GET /v1/users/me: response has no data.id');
  return id;
}

export function confirmIntegration(
  accessToken: string,
  accountIdentifier: string,
  nonce: string,
): Promise<unknown> {
  return call('POST app-integrations', `${RING_API}/v1/accounts/me/app-integrations`, {
    method: 'POST',
    headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_identifier: accountIdentifier, nonce }),
  });
}

export function completeIntegration(accessToken: string): Promise<unknown> {
  return call('PATCH app-integrations', `${RING_API}/v1/accounts/me/app-integrations`, {
    method: 'PATCH',
    headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' }),
  });
}

export interface RingDevice {
  id: string;
  name?: string;
}

export async function listDevices(accessToken: string): Promise<RingDevice[]> {
  const body = (await call('GET /v1/devices', `${RING_API}/v1/devices`, {
    headers: bearer(accessToken),
  })) as { data?: { id: string; attributes?: { name?: string } }[] };
  return (body.data ?? []).map((d) => ({ id: d.id, name: d.attributes?.name }));
}

export interface ImageAttempt {
  status: number; // step-1 status on an error, else the step-2 (media GET) status
  step: 1 | 2;
  error_code?: string;
  content_type?: string;
  bytes?: number;
  media_timestamp?: number;
  media_origin?: string;
}

// Ring error bodies carry an upper-snake code such as RECORDING_NOT_READY (api-documentation.html).
function errorCode(text: string): string | undefined {
  return /\b[A-Z][A-Z_]{4,}[A-Z]\b/.exec(text)?.[0];
}

// POST /media/image/download with type at_timestamp, then GET the 303 Location.
// The image bytes are counted and dropped; callers that need the frame are not built yet.
export async function downloadImageAt(
  accessToken: string,
  deviceId: string,
  timestampMs: number,
): Promise<ImageAttempt> {
  const r1 = await fetch(`${RING_API}/v1/devices/${deviceId}/media/image/download`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'at_timestamp',
      timestamp: timestampMs,
      image_options: { format: 'jpeg' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const location = r1.headers.get('location');
  if (!location) {
    const text = await r1.text();
    return { status: r1.status, step: 1, error_code: errorCode(text) };
  }
  const r2 = await fetch(location, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const buf = Buffer.from(await r2.arrayBuffer());
  const mediaTs = Number(r2.headers.get('x-media-timestamp'));
  return {
    status: r2.status,
    step: 2,
    ...(r2.ok ? {} : { error_code: errorCode(buf.toString('utf8')) }),
    content_type: r2.headers.get('content-type') ?? undefined,
    bytes: buf.length,
    media_timestamp: Number.isFinite(mediaTs) && mediaTs > 0 ? mediaTs : undefined,
    media_origin: r2.headers.get('x-media-origin') ?? undefined,
  };
}
