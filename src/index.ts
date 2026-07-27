#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './lib/config.js';
import { SERVER_NAME, createServer, formatError } from './server.js';
import { allTools } from './tools/index.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // stderr: stdout is the MCP transport and must stay clean.
      process.stderr.write(`[${SERVER_NAME}] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const server = createServer(config);

  process.stderr.write(
    `[${SERVER_NAME}] ready — ${allTools.length} tools, ` +
      `dry-run ${config.dryRun ? 'ON' : 'OFF'}` +
      (config.allowedPolicyIDs.size > 0
        ? `, restricted to policies ${[...config.allowedPolicyIDs].join(', ')}`
        : '') +
      '\n',
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${formatError(error)}\n`);
  process.exit(1);
});
