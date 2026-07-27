import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Vercel functions are stateless, so OAuth artifacts cannot live in memory.
 * Everything here is a signed, self-contained token instead of a stored row:
 * the value carries its own claims and an HMAC over them, keyed by a server
 * secret. No database required.
 */

export interface TokenClaims {
  /** Subject — always the single owner of this deployment. */
  sub: string;
  /** OAuth client that requested it, from dynamic registration. */
  client_id: string;
  /** Audience: the canonical MCP server URI. RFC 8707 binding. */
  aud: string;
  /** Seconds since epoch. */
  exp: number;
  /** Distinguishes access tokens from authorization codes. */
  typ: 'access' | 'code' | 'refresh';
  /** PKCE challenge, carried on authorization codes only. */
  cc?: string;
  /** Redirect URI the code was issued for, to bind the exchange. */
  ru?: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(
    input.replace(/-/g, '+').replace(/_/g, '/') + pad,
    'base64',
  );
}

function sign(payload: string, secret: string): string {
  return b64url(
    createHash('sha256').update(`${payload}.${secret}`).digest(),
  );
}

export function issueToken(claims: TokenClaims, secret: string): string {
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export type VerifyResult =
  | { valid: true; claims: TokenClaims }
  | { valid: false; reason: string };

export function verifyToken(
  token: string,
  secret: string,
  expected: { typ: TokenClaims['typ']; aud?: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed token' };

  const [payload, signature] = parts as [string, string];
  const expectedSig = sign(payload, secret);

  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad signature' };
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as TokenClaims;
  } catch {
    return { valid: false, reason: 'unreadable claims' };
  }

  if (claims.typ !== expected.typ) {
    return { valid: false, reason: `expected ${expected.typ} token` };
  }
  if (claims.exp <= nowSeconds) return { valid: false, reason: 'expired' };

  // RFC 8707: a token must be rejected unless it was minted for this server.
  if (expected.aud !== undefined && claims.aud !== expected.aud) {
    return { valid: false, reason: 'wrong audience' };
  }

  return { valid: true, claims };
}

/** RFC 7636 S256 verification. */
export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  const computed = b64url(createHash('sha256').update(codeVerifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Client IDs are derived from the registration request rather than stored, so
 * any Vercel instance can validate one without shared state.
 */
export function deriveClientId(redirectUris: string[], secret: string): string {
  return b64url(
    createHash('sha256')
      .update(`${redirectUris.slice().sort().join('|')}.${secret}`)
      .digest(),
  ).slice(0, 32);
}

export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
