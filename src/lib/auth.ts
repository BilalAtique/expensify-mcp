import { timingSafeEqual } from 'node:crypto';

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

/**
 * Compares without leaking length or content through timing. timingSafeEqual
 * throws on length mismatch, so lengths are checked first — that only reveals
 * token length, which is not secret.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

/**
 * Gates the HTTP transport. This endpoint can write to a real Expensify
 * account, so an unset MCP_AUTH_TOKEN refuses every request (503) rather than
 * silently running open — a misconfigured deploy must not become a public
 * write endpoint.
 */
export function authorizeRequest(
  authorizationHeader: string | undefined,
  expectedToken: string | undefined,
): AuthResult {
  if (!expectedToken || expectedToken.trim().length === 0) {
    return {
      ok: false,
      status: 503,
      message:
        'Server is not configured: MCP_AUTH_TOKEN is unset. Refusing all ' +
        'requests rather than exposing an unauthenticated write endpoint.',
    };
  }

  const provided = extractToken(authorizationHeader);
  if (!provided) {
    return {
      ok: false,
      status: 401,
      message: 'Missing bearer token. Send: Authorization: Bearer <token>',
    };
  }

  if (!safeEqual(provided, expectedToken)) {
    return { ok: false, status: 401, message: 'Invalid bearer token.' };
  }

  return { ok: true };
}
