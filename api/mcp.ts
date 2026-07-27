import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { authorizeRequest } from '../src/lib/auth.js';
import { ConfigError, loadConfig } from '../src/lib/config.js';
import { baseUrlFrom, canonicalResource } from '../src/lib/oauth-config.js';
import { verifyToken } from '../src/lib/oauth-store.js';
import { createServer } from '../src/server.js';

/**
 * Two ways in:
 *   1. An OAuth access token this server issued (claude.ai custom connectors).
 *   2. A static MCP_AUTH_TOKEN bearer (Claude Code, curl, scripts).
 *
 * Either alone is sufficient. OAuth is tried first because a connector always
 * presents one, and a static-token deployment simply has no signing secret.
 */
function checkAuth(
  req: IncomingMessage,
): { ok: true } | { ok: false; status: number; message: string } {
  const header = req.headers.authorization;
  const signingSecret = process.env.MCP_OAUTH_SIGNING_SECRET?.trim();
  const staticToken = process.env.MCP_AUTH_TOKEN?.trim();

  const presented = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (presented && signingSecret) {
    const result = verifyToken(presented, signingSecret, {
      typ: 'access',
      aud: canonicalResource(req),
    });
    if (result.valid) return { ok: true };
  }

  if (staticToken) return authorizeRequest(header, staticToken);

  if (!signingSecret) {
    return {
      ok: false,
      status: 503,
      message:
        'Server is not configured: set MCP_OAUTH_SIGNING_SECRET (for OAuth) ' +
        'or MCP_AUTH_TOKEN (for static bearer auth).',
    };
  }

  return { ok: false, status: 401, message: 'Invalid or expired access token.' };
}

/**
 * Streamable HTTP MCP endpoint.
 *
 * Stateless: a fresh server and transport are built per request, since Vercel
 * functions may not reuse an instance between calls and MCP sessions cannot be
 * assumed to land on the same one.
 */
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const auth = checkAuth(req);

  if (auth.ok === false) {
    // RFC 9728: point the client at the protected-resource metadata so it can
    // discover the authorization server and start an OAuth flow on its own.
    if (auth.status === 401) {
      const metadataUrl = `${baseUrlFrom(req)}/.well-known/oauth-protected-resource`;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="expensify-mcp", resource_metadata="${metadataUrl}"`,
      );
    }
    res.statusCode = auth.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: auth.message },
        id: null,
      }),
    );
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const message =
      error instanceof ConfigError
        ? error.message
        : 'Failed to load server configuration';
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32002, message },
        id: null,
      }),
    );
    return;
  }

  const server = createServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : 'Internal server error',
          },
          id: null,
        }),
      );
    }
  }
}
