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
