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

/**
 * Error hints are written for the model that will read them. Where an error is
 * known NOT to be transient, they say so explicitly — otherwise the model
 * reads a bare 500 as an outage and offers to retry forever.
 */
function hintFor(error: ExpensifyApiError): string {
  switch (error.responseCode) {
    case 410:
      return (
        '\nHint: 410 is a validation failure. Check dates are yyyy-MM-dd, ' +
        'amounts are integer cents, and any category/tag already exists on ' +
        'the policy.'
      );
    case 429:
      return (
        '\nHint: rate limited (5 req/10s, 20 req/60s). Retries were already ' +
        'exhausted; wait before trying again.'
      );
    case 403:
      return (
        '\nHint: 403 here means the account lacks the plan or verified domain ' +
        'this job requires — not a malformed payload. DO NOT RETRY; the result ' +
        'will be identical. Report this to the user as an account limitation.'
      );
    case 500:
      if (error.jobKind === 'file' || error.jobKind === 'reconciliation') {
        return (
          '\nHint: export jobs return 500 for accounts without the required ' +
          'plan. This has been verified as DETERMINISTIC, not a transient ' +
          'outage: it reproduces even with a literal template that never ' +
          'touches report data, while other endpoints on the same credentials ' +
          'succeed.\n' +
          'DO NOT RETRY and DO NOT describe this as temporary. Tell the user ' +
          'that report export appears unavailable on this Expensify account ' +
          '(likely a plan restriction) and that the web UI is the way to view ' +
          'reports.'
        );
      }
      return (
        '\nHint: 500 is a server-side failure at Expensify. If it repeats ' +
        'identically, treat it as deterministic rather than transient.'
      );
    default:
      return '';
  }
}

export function formatError(error: unknown): string {
  if (error instanceof WriteGuardError) {
    return `Blocked before sending (${error.reason}): ${error.message}`;
  }
  if (error instanceof ExpensifyApiError) {
    return `${error.message}${hintFor(error)}`;
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
