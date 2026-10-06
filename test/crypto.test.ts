import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkLinkFreshness,
  computeNonce,
  computeWebhookSignature,
  nonceMatches,
  verifyWebhookSignature,
} from '../src/crypto.ts';

// RFC 4231 test case 2 pins the HMAC-SHA256 primitive to a published vector.
const RFC_KEY = 'Jefe';
const RFC_DATA = 'what do ya want for nothing?';
const RFC_HEX = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';

describe('webhook signature (hex, sha256= prefix)', () => {
  const body = Buffer.from('{"meta":{"request_id":"r1"},"data":{"type":"motion_detected"}}');
  const key = 'test-hmac-key';
  const good = `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

  it('matches the RFC 4231 vector', () => {
    expect(computeWebhookSignature(RFC_KEY, Buffer.from(RFC_DATA))).toBe(RFC_HEX);
  });
  it('accepts a correct signature with or without the prefix', () => {
    expect(verifyWebhookSignature(key, body, good)).toBe(true);
    expect(verifyWebhookSignature(key, body, good.slice(7))).toBe(true);
  });
  it('rejects a tampered body, a wrong key, and a missing header', () => {
    expect(verifyWebhookSignature(key, Buffer.from(body.toString() + ' '), good)).toBe(false);
    expect(verifyWebhookSignature('other-key', body, good)).toBe(false);
    expect(verifyWebhookSignature(key, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(key, body, 'sha256=')).toBe(false);
  });
  it('fails on re-serialized JSON, which is why the raw body must be used', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(verifyWebhookSignature(key, reserialized, good)).toBe(false);
  });
});

describe('account-link nonce (base64url, no padding)', () => {
  it('encodes the RFC vector digest as unpadded base64url', () => {
    const expected = Buffer.from(RFC_HEX, 'hex').toString('base64url');
    // "<time>:<account_id>" with time="what do ya want for nothing?" split at ":" is not
    // possible, so check encoding on a direct HMAC instead.
    const n = createHmac('sha256', RFC_KEY).update(RFC_DATA).digest('base64url');
    expect(n).toBe(expected);
    expect(n).not.toMatch(/[+/=]/);
  });
  it('signs "<time>:<account_id>"', () => {
    const key = 'k';
    const manual = createHmac('sha256', key)
      .update('1771130906289:ava1.ring.account.ABC')
      .digest('base64url');
    expect(computeNonce('1771130906289', 'ava1.ring.account.ABC', key)).toBe(manual);
  });
  it('matches only the account the nonce was issued for', () => {
    const n = computeNonce('1771130906289', 'acct-A', 'k');
    expect(nonceMatches(n, '1771130906289', 'acct-A', 'k')).toBe(true);
    expect(nonceMatches(n, '1771130906289', 'acct-B', 'k')).toBe(false);
    expect(nonceMatches(n, '1771130906290', 'acct-A', 'k')).toBe(false);
  });
});

describe('link freshness (600 s window)', () => {
  const t = 1_771_130_906_289;
  it('accepts inside the window and at its edge', () => {
    expect(checkLinkFreshness(String(t), t + 1_000)).toEqual({ ok: true });
    expect(checkLinkFreshness(String(t), t + 600_000)).toEqual({ ok: true });
  });
  it('rejects expired, future, and malformed times', () => {
    expect(checkLinkFreshness(String(t), t + 600_001)).toEqual({ ok: false, reason: 'expired' });
    expect(checkLinkFreshness(String(t), t - 1)).toEqual({ ok: false, reason: 'future' });
    expect(checkLinkFreshness('abc', t)).toEqual({ ok: false, reason: 'invalid' });
  });
});
