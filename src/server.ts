import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ExpensifyClient } from './lib/client.js';
import type { Config } from './lib/config.js';
import {
  ExpensifyApiError,
  ExpensifyTransportError,
  WriteGuardError,
} from './lib/errors.js';
import { allTools } from './tools/index.js';
import type { ToolDeps } from './tools/types.js';

export const SERVER_NAME = 'expensify-mcp';
export const SERVER_VERSION = '0.1.0';

export function formatError(error: unknown): string {
  if (error instanceof WriteGuardError) {
    return `Blocked before sending (${error.reason}): ${error.message}`;
  }
  if (error instanceof ExpensifyApiError) {
    const hint =
      error.responseCode === 410
        ? '\nHint: 410 means validation failed. Check that dates are yyyy-MM-dd, ' +
          'amounts are integer cents, and that any category/tag already exists ' +
          'on the policy.'
        : error.responseCode === 429
          ? '\nHint: rate limited (5 req/10s, 20 req/60s). Retries were ' +
            'exhausted; wait and try again.'
          : error.responseCode === 403
            ? '\nHint: 403 usually means the account lacks the plan or verified ' +
              'domain this job requires, rather than a malformed payload.'
            : '';
    return `${error.message}${hint}`;
  }
  if (error instanceof ExpensifyTransportError) {
    return `${error.message}${error.body ? `\nBody: ${error.body}` : ''}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Builds a fully-registered MCP server. Both the stdio entrypoint and the HTTP
 * handler call this, so the two transports can never drift apart.
 */
export function createServer(config: Config): McpServer {
  const client = new ExpensifyClient(config);
  const deps: ToolDeps = { client, config };

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  for (const tool of allTools) {
    const description = tool.mutating
      ? `${tool.description}\n\nWRITES to Expensify.${
          config.dryRun
            ? ' Dry-run is currently ON — this will preview only.'
            : ''
        }`
      : tool.description;

    server.registerTool(
      tool.name,
      {
        description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: !tool.mutating,
          destructiveHint: tool.mutating,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(args as never, deps);
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: formatError(error) }],
          };
        }
      },
    );
  }

  return server;
}
