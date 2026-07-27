import type { z } from 'zod';
import type { ExpensifyClient } from '../lib/client.js';
import type { Config } from '../lib/config.js';

export interface ToolDeps {
  client: ExpensifyClient;
  config: Config;
}

/**
 * MCP passes tool arguments as a plain object. Each tool owns its Zod shape and
 * the server validates against it before the handler runs.
 */
export interface ToolDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: TShape;
  /** Marks tools that mutate Expensify data, for annotation + logging. */
  mutating: boolean;
  handler: (
    args: z.objectOutputType<TShape, z.ZodTypeAny>,
    deps: ToolDeps,
  ) => Promise<unknown>;
}

/** Helper that preserves the shape's type through registration. */
export function defineTool<TShape extends z.ZodRawShape>(
  definition: ToolDefinition<TShape>,
): ToolDefinition<TShape> {
  return definition;
}
