import type { IncomingMessage } from 'node:http';

/**
 * The canonical server URI (RFC 8707 audience) must match what the client
 * derives from the URL it connects to, so it is computed from the request
 * rather than hardcoded.
 */
export function baseUrlFrom(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ??
    (host.startsWith('localhost') || host.startsWith('127.0.0.1')
      ? 'http'
      : 'https');
  return `${proto}://${host}`;
}

export function canonicalResource(req: IncomingMessage): string {
  return `${baseUrlFrom(req)}/mcp`;
}

export interface OAuthEnv {
  /** Signs tokens and derives client IDs. */
  signingSecret: string;
  /** Password gating the authorize screen — proves the owner is present. */
  ownerPassword: string;
}

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigError';
    Object.setPrototypeOf(this, OAuthConfigError.prototype);
  }
}

/**
 * Fails closed: without both secrets the OAuth endpoints refuse to operate
 * rather than issuing tokens anyone could mint or approve.
 */
export function loadOAuthEnv(env: NodeJS.ProcessEnv = process.env): OAuthEnv {
  const signingSecret = env.MCP_OAUTH_SIGNING_SECRET?.trim();
  const ownerPassword = env.MCP_OWNER_PASSWORD?.trim();

  if (!signingSecret || signingSecret.length < 16) {
    throw new OAuthConfigError(
      'MCP_OAUTH_SIGNING_SECRET is unset or too short (need >= 16 chars).',
    );
  }
  if (!ownerPassword || ownerPassword.length < 8) {
    throw new OAuthConfigError(
      'MCP_OWNER_PASSWORD is unset or too short (need >= 8 chars).',
    );
  }

  return { signingSecret, ownerPassword };
}

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const CODE_TTL_SECONDS = 60 * 5;
export const OWNER_SUBJECT = 'owner';
