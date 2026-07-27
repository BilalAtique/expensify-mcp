import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  constantTimeEquals,
  deriveClientId,
  issueToken,
  verifyPkce,
  verifyToken,
} from './oauth-store.js';

const SECRET = 'a-signing-secret-at-least-16-chars';
const AUD = 'https://example.com/mcp';
const NOW = 1_700_000_000;

const claims = {
  sub: 'owner',
  client_id: 'client-1',
  aud: AUD,
  exp: NOW + 3600,
  typ: 'access' as const,
};

describe('token issue/verify', () => {
  test('round-trips a valid token', () => {
    const token = issueToken(claims, SECRET);
    const result = verifyToken(token, SECRET, { typ: 'access', aud: AUD }, NOW);
    expect(result.valid).toBe(true);
  });

  test('rejects a token signed with a different secret', () => {
    const token = issueToken(claims, SECRET);
    const result = verifyToken(token, 'other-secret-16-chars', { typ: 'access' }, NOW);
    expect(result.valid).toBe(false);
  });

  test('rejects a tampered payload', () => {
    const token = issueToken(claims, SECRET);
    const [payload, sig] = token.split('.');
    const evil = Buffer.from(
      JSON.stringify({ ...claims, sub: 'attacker' }),
    ).toString('base64url');
    const result = verifyToken(`${evil}.${sig}`, SECRET, { typ: 'access' }, NOW);
    expect(result.valid).toBe(false);
    expect(payload).toBeDefined();
  });

  test('rejects an expired token', () => {
    const token = issueToken({ ...claims, exp: NOW - 1 }, SECRET);
    const result = verifyToken(token, SECRET, { typ: 'access' }, NOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  test('rejects the wrong audience (RFC 8707 binding)', () => {
    const token = issueToken(claims, SECRET);
    const result = verifyToken(
      token,
      SECRET,
      { typ: 'access', aud: 'https://evil.com/mcp' },
      NOW,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('wrong audience');
  });

  test('refuses to accept a code where an access token is required', () => {
    const code = issueToken({ ...claims, typ: 'code' }, SECRET);
    const result = verifyToken(code, SECRET, { typ: 'access', aud: AUD }, NOW);
    expect(result.valid).toBe(false);
  });

  test('rejects malformed input', () => {
    for (const bad of ['', 'nodot', 'a.b.c']) {
      expect(verifyToken(bad, SECRET, { typ: 'access' }, NOW).valid).toBe(false);
    }
  });
});

describe('PKCE', () => {
  test('accepts a correct S256 verifier', () => {
    const verifier = 'a'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  test('rejects a wrong verifier', () => {
    const challenge = createHash('sha256')
      .update('a'.repeat(64))
      .digest('base64url');
    expect(verifyPkce('b'.repeat(64), challenge)).toBe(false);
  });
});

describe('client id derivation', () => {
  test('is stable for the same redirect URIs', () => {
    const a = deriveClientId(['https://claude.ai/cb'], SECRET);
    const b = deriveClientId(['https://claude.ai/cb'], SECRET);
    expect(a).toBe(b);
  });

  test('differs for different redirect URIs', () => {
    const a = deriveClientId(['https://claude.ai/cb'], SECRET);
    const b = deriveClientId(['https://evil.com/cb'], SECRET);
    expect(a).not.toBe(b);
  });

  test('cannot be forged without the signing secret', () => {
    const real = deriveClientId(['https://claude.ai/cb'], SECRET);
    const forged = deriveClientId(['https://claude.ai/cb'], 'guessed-secret');
    expect(real).not.toBe(forged);
  });
});

describe('constantTimeEquals', () => {
  test('matches identical strings and rejects others', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});
