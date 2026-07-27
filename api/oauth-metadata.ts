import type { IncomingMessage, ServerResponse } from 'node:http';
import { baseUrlFrom, canonicalResource } from '../src/lib/oauth-config.js';

/**
 * Serves both discovery documents:
 *   /.well-known/oauth-protected-resource  (RFC 9728)
 *   /.well-known/oauth-authorization-server (RFC 8414)
 *
 * This deployment is both the resource server and its own authorization
 * server, so the two documents point at the same origin.
 */
export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const base = baseUrlFrom(req);
  const url = req.url ?? '';

  res.setHeader('Content-Type', 'application/json');
  // Discovery is public and static; let clients and the CDN cache it.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.includes('oauth-protected-resource')) {
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        resource: canonicalResource(req),
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['expensify'],
      }),
    );
    return;
  }

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: ['expensify'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      // PKCE is mandatory for public clients under OAuth 2.1.
      code_challenge_methods_supported: ['S256'],
    }),
  );
}
