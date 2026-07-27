import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from './config.js';

const base = {
  EXPENSIFY_PARTNER_USER_ID: 'pid',
  EXPENSIFY_PARTNER_USER_SECRET: 'psecret',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  test('throws when credentials are missing', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  test('defaults dry-run ON when unset', () => {
    expect(loadConfig({ ...base }).dryRun).toBe(true);
  });

  test('only an explicit "false" disables dry-run', () => {
    expect(loadConfig({ ...base, EXPENSIFY_DRY_RUN: 'false' }).dryRun).toBe(
      false,
    );
    expect(loadConfig({ ...base, EXPENSIFY_DRY_RUN: 'FALSE' }).dryRun).toBe(
      false,
    );
  });

  test('a typo in the dry-run flag fails closed', () => {
    // "flase"/"0"/"no" must not be read as an intent to disable protection.
    for (const value of ['flase', '0', 'no', 'off', '']) {
      expect(loadConfig({ ...base, EXPENSIFY_DRY_RUN: value }).dryRun).toBe(
        true,
      );
    }
  });

  test('parses the policy allowlist', () => {
    const config = loadConfig({
      ...base,
      EXPENSIFY_ALLOWED_POLICY_IDS: 'A1, B2 ,C3',
    });
    expect([...config.allowedPolicyIDs].sort()).toEqual(['A1', 'B2', 'C3']);
  });

  test('empty allowlist means unrestricted', () => {
    expect(loadConfig({ ...base }).allowedPolicyIDs.size).toBe(0);
  });

  test('rejects an invalid batch size', () => {
    expect(() =>
      loadConfig({ ...base, EXPENSIFY_MAX_BATCH_SIZE: 'abc' }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, EXPENSIFY_MAX_BATCH_SIZE: '0' }),
    ).toThrow(ConfigError);
  });
});
