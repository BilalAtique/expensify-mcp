import { describe, expect, test } from 'bun:test';
import { authorizeRequest } from './auth.js';

const TOKEN = 'super-secret-token-value';

describe('authorizeRequest', () => {
  test('accepts a correct bearer token', () => {
    expect(authorizeRequest(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
  });

  test('is case-insensitive on the Bearer scheme', () => {
    expect(authorizeRequest(`bearer ${TOKEN}`, TOKEN).ok).toBe(true);
  });

  test('rejects a wrong token', () => {
    const result = authorizeRequest('Bearer wrong-token', TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  test('rejects a missing header', () => {
    const result = authorizeRequest(undefined, TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  test('rejects a non-bearer scheme', () => {
    expect(authorizeRequest(`Basic ${TOKEN}`, TOKEN).ok).toBe(false);
  });

  test('rejects a bare token with no scheme', () => {
    expect(authorizeRequest(TOKEN, TOKEN).ok).toBe(false);
  });

  test('fails closed with 503 when no token is configured', () => {
    // A misconfigured deploy must never become a public write endpoint.
    for (const missing of [undefined, '', '   ']) {
      const result = authorizeRequest(`Bearer ${TOKEN}`, missing);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(503);
    }
  });

  test('a prefix of the real token is rejected', () => {
    expect(authorizeRequest('Bearer super-secret', TOKEN).ok).toBe(false);
  });

  test('a token with extra suffix is rejected', () => {
    expect(authorizeRequest(`Bearer ${TOKEN}extra`, TOKEN).ok).toBe(false);
  });
});
