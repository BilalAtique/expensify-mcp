import type { ToolDefinition } from './types.js';
import { readTools } from './read.js';
import { exportTools } from './export.js';
import { expenseWriteTools } from './write-expenses.js';
import { policyWriteTools } from './write-policy.js';

export const allTools: ToolDefinition[] = [
  ...readTools,
  ...exportTools,
  ...expenseWriteTools,
  ...policyWriteTools,
] as ToolDefinition[];

export { readTools, exportTools, expenseWriteTools, policyWriteTools };
