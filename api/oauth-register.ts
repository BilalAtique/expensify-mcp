import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OAuthConfigError,
  loadOAuthEnv,
} from '../src/lib/oauth-config.js';
import { deriveClientId } from '../src/lib/oauth-store.js';

interface RegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
}

function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Registration is open — that is intentional and safe here. A client ID alone
 * grants nothing: every authorization still requires the owner password on the
 * consent screen. Client IDs are derived from the redirect URIs rather than
 * stored, so any stateless instance can validate them.
 */
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  let env;
  try {
    env = loadOAuthEnv();
  } catch (error) {
    res.statusCode = 503;
    res.end(
      JSON.stringify({
        error: 'server_error',
        error_description:
          error instanceof OAuthConfigError
            ? error.message
            : 'configuration error',
      }),
    );
    return;
  }

  const body = (await readBody(req)) as RegistrationRequest;
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];

  if (redirectUris.length === 0) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris is required',
      }),
    );
    return;
  }

  // Only HTTPS or loopback redirects, per OAuth 2.1.
  const invalid = redirectUris.filter((uri) => {
    try {
      const parsed = new URL(uri);
      return !(
        parsed.protocol === 'https:' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1'
      );
    } catch {
      return true;
    }
  });

  if (invalid.length > 0) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        error: 'invalid_redirect_uri',
        error_description: `Must be HTTPS or loopback: ${invalid.join(', ')}`,
      }),
    );
    return;
  }

  const clientId = deriveClientId(redirectUris, env.signingSecret);

  res.statusCode = 201;
  res.end(
    JSON.stringify({
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name:
        typeof body.client_name === 'string' ? body.client_name : 'mcp-client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }),
  );
}
