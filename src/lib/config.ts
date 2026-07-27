export interface Config {
  partnerUserID: string;
  partnerUserSecret: string;
  /** When true, mutating tools return a preview instead of calling the API. */
  dryRun: boolean;
  /** If non-empty, mutations are refused for any policy outside this set. */
  allowedPolicyIDs: Set<string>;
  maxBatchSize: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * Dry-run is opt-OUT rather than opt-in: anything other than an explicit
 * "false" leaves protection on. A typo in the env var fails closed.
 */
function parseDryRun(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== 'false';
}

function parseMaxBatchSize(raw: string | undefined): number {
  if (!raw) return 100;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ConfigError(
      `EXPENSIFY_MAX_BATCH_SIZE must be a positive integer, got: ${raw}`,
    );
  }
  return parsed;
}

function parsePolicyIDs(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const partnerUserID = env.EXPENSIFY_PARTNER_USER_ID?.trim();
  const partnerUserSecret = env.EXPENSIFY_PARTNER_USER_SECRET?.trim();

  if (!partnerUserID || !partnerUserSecret) {
    throw new ConfigError(
      'Missing Expensify credentials. Set EXPENSIFY_PARTNER_USER_ID and ' +
        'EXPENSIFY_PARTNER_USER_SECRET. Generate them at ' +
        'https://www.expensify.com/tools/integrations/',
    );
  }

  return {
    partnerUserID,
    partnerUserSecret,
    dryRun: parseDryRun(env.EXPENSIFY_DRY_RUN),
    allowedPolicyIDs: parsePolicyIDs(env.EXPENSIFY_ALLOWED_POLICY_IDS),
    maxBatchSize: parseMaxBatchSize(env.EXPENSIFY_MAX_BATCH_SIZE),
  };
}
