import type { Config } from './config.js';
import type { ExpensifyClient, ExpensifyResponse, JobRequest } from './client.js';
import { WriteGuardError } from './errors.js';

export interface GuardContext {
  /** Policy IDs this mutation touches, for the allowlist check. */
  policyIDs?: string[];
  /** Number of records being written, for the batch cap. */
  batchSize?: number;
  /** Human-readable summary shown in the dry-run preview. */
  summary: string;
}

export interface DryRunResult {
  dryRun: true;
  summary: string;
  wouldSend: Record<string, unknown>;
  note: string;
}

export type GuardedResult = DryRunResult | ExpensifyResponse;

export function isDryRunResult(value: GuardedResult): value is DryRunResult {
  return (value as DryRunResult).dryRun === true;
}

/**
 * Single chokepoint for every mutating call. Read-only jobs bypass this and
 * go straight to the client.
 */
export async function executeWrite(
  client: ExpensifyClient,
  config: Config,
  request: JobRequest,
  context: GuardContext,
): Promise<GuardedResult> {
  if (config.allowedPolicyIDs.size > 0 && context.policyIDs?.length) {
    const blocked = context.policyIDs.filter(
      (id) => !config.allowedPolicyIDs.has(id),
    );
    if (blocked.length > 0) {
      throw new WriteGuardError(
        'policy-not-allowed',
        `Refused: policy ID(s) ${blocked.join(', ')} are not in ` +
          `EXPENSIFY_ALLOWED_POLICY_IDS. Allowed: ` +
          `${[...config.allowedPolicyIDs].join(', ')}`,
        { blocked, allowed: [...config.allowedPolicyIDs] },
      );
    }
  }

  if (
    context.batchSize !== undefined &&
    context.batchSize > config.maxBatchSize
  ) {
    throw new WriteGuardError(
      'batch-too-large',
      `Refused: batch of ${context.batchSize} exceeds EXPENSIFY_MAX_BATCH_SIZE ` +
        `(${config.maxBatchSize}). Split the request or raise the limit.`,
      { batchSize: context.batchSize, maxBatchSize: config.maxBatchSize },
    );
  }

  if (config.dryRun) {
    return {
      dryRun: true,
      summary: context.summary,
      wouldSend: client.buildRedactedJobDescription(request),
      note:
        'DRY RUN — nothing was sent to Expensify. Set EXPENSIFY_DRY_RUN=false ' +
        'to perform real writes.',
    };
  }

  return client.execute(request);
}
