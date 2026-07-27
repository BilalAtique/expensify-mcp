import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { authorizeRequest } from '../src/lib/auth.js';
import { ConfigError, loadConfig } from '../src/lib/config.js';
import { createServer } from '../src/server.js';

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
  const auth = authorizeRequest(
    req.headers.authorization,
    process.env.MCP_AUTH_TOKEN,
  );

  if (auth.ok === false) {
    // WWW-Authenticate tells a compliant client how to authenticate.
    if (auth.status === 401) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="expensify-mcp"');
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
