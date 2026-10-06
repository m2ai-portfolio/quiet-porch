// Ring HMAC checks. One key, two encodings (Ring docs, api-documentation.html):
//   webhook X-Signature: "sha256=" + hex(HMAC-SHA256(key, raw body bytes))
//   account-link nonce:  base64url-no-pad(HMAC-SHA256(key, "<time>:<account_id>"))
import { createHmac, timingSafeEqual } from 'node:crypto';

export const NONCE_WINDOW_SECONDS = 600;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function computeWebhookSignature(key: string, rawBody: Buffer): string {
  return createHmac('sha256', key).update(rawBody).digest('hex');
}

// Must be given the body exactly as received; re-serialized JSON changes the bytes.
export function verifyWebhookSignature(
  key: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const received = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  return safeEqual(computeWebhookSignature(key, rawBody), received.toLowerCase());
}

export function computeNonce(time: string, accountId: string, key: string): string {
  return createHmac('sha256', key).update(`${time}:${accountId}`).digest('base64url');
}

export function nonceMatches(nonce: string, time: string, accountId: string, key: string): boolean {
  return safeEqual(computeNonce(time, accountId, key), nonce);
}

export type Freshness = { ok: true } | { ok: false; reason: 'expired' | 'future' | 'invalid' };

export function checkLinkFreshness(timeParam: string, nowMs: number): Freshness {
  if (!/^\d{10,16}$/.test(timeParam)) return { ok: false, reason: 'invalid' };
  const deltaSeconds = (nowMs - Number(timeParam)) / 1000;
  if (deltaSeconds < 0) return { ok: false, reason: 'future' };
  if (deltaSeconds > NONCE_WINDOW_SECONDS) return { ok: false, reason: 'expired' };
  return { ok: true };
}
