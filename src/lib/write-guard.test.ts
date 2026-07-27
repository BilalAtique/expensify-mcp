import { describe, expect, test } from 'bun:test';
import { ExpensifyClient } from './client.js';
import type { Config } from './config.js';
import { WriteGuardError } from './errors.js';
import { executeWrite, isDryRunResult } from './write-guard.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    partnerUserID: 'test-id',
    partnerUserSecret: 'test-secret',
    dryRun: false,
    allowedPolicyIDs: new Set<string>(),
    maxBatchSize: 100,
    ...overrides,
  };
}

/** Records whether the network was touched at all. */
function makeClient(config: Config) {
  let called = 0;
  const fetchImpl = (async () => {
    called += 1;
    return new Response(JSON.stringify({ responseCode: 200 }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const client = new ExpensifyClient(config, { fetchImpl });
  return { client, calls: () => called };
}

const request = {
  type: 'create' as const,
  inputSettings: { type: 'expenses' },
};

describe('executeWrite', () => {
  test('dry-run returns a preview and never calls the API', async () => {
    const config = makeConfig({ dryRun: true });
    const { client, calls } = makeClient(config);

    const result = await executeWrite(client, config, request, {
      summary: 'create 1 expense',
    });

    expect(calls()).toBe(0);
    expect(isDryRunResult(result)).toBe(true);
    if (isDryRunResult(result)) {
      expect(result.summary).toBe('create 1 expense');
    }
  });

  test('dry-run preview never leaks the partner secret', async () => {
    const config = makeConfig({ dryRun: true });
    const { client } = makeClient(config);

    const result = await executeWrite(client, config, request, {
      summary: 'x',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-secret');
    expect(serialized).toContain('***redacted***');
  });

  test('calls the API when dry-run is off', async () => {
    const config = makeConfig({ dryRun: false });
    const { client, calls } = makeClient(config);

    const result = await executeWrite(client, config, request, {
      summary: 'x',
    });

    expect(calls()).toBe(1);
    expect(isDryRunResult(result)).toBe(false);
  });

  test('refuses a policy outside the allowlist', async () => {
    const config = makeConfig({ allowedPolicyIDs: new Set(['ALLOWED']) });
    const { client, calls } = makeClient(config);

    await expect(
      executeWrite(client, config, request, {
        policyIDs: ['BLOCKED'],
        summary: 'x',
      }),
    ).rejects.toBeInstanceOf(WriteGuardError);
    expect(calls()).toBe(0);
  });

  test('permits a policy inside the allowlist', async () => {
    const config = makeConfig({ allowedPolicyIDs: new Set(['ALLOWED']) });
    const { client, calls } = makeClient(config);

    await executeWrite(client, config, request, {
      policyIDs: ['ALLOWED'],
      summary: 'x',
    });

    expect(calls()).toBe(1);
  });

  test('refuses a batch over the cap', async () => {
    const config = makeConfig({ maxBatchSize: 10 });
    const { client, calls } = makeClient(config);

    const error = await executeWrite(client, config, request, {
      batchSize: 11,
      summary: 'x',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WriteGuardError);
    expect((error as WriteGuardError).reason).toBe('batch-too-large');
    expect(calls()).toBe(0);
  });

  test('guards run before dry-run so a blocked write is never previewed', async () => {
    const config = makeConfig({
      dryRun: true,
      allowedPolicyIDs: new Set(['ALLOWED']),
    });
    const { client } = makeClient(config);

    await expect(
      executeWrite(client, config, request, {
        policyIDs: ['BLOCKED'],
        summary: 'x',
      }),
    ).rejects.toBeInstanceOf(WriteGuardError);
  });
});
