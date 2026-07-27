import { describe, expect, test } from 'bun:test';
import { ExpensifyClient } from './client.js';
import type { Config } from './config.js';
import { ExpensifyApiError, ExpensifyTransportError } from './errors.js';
import { RateLimiter } from './rate-limiter.js';

const config: Config = {
  partnerUserID: 'pid',
  partnerUserSecret: 'psecret',
  dryRun: false,
  allowedPolicyIDs: new Set<string>(),
  maxBatchSize: 100,
};

/** No-op limiter so transport tests do not wait on real windows. */
function noWaitLimiter() {
  return new RateLimiter([{ limit: 1_000_000, intervalMs: 1 }], {
    now: () => 0,
    sleep: async () => {},
  });
}

function clientWith(
  handler: (body: string) => Response,
  captured?: { body?: string; contentType?: string },
) {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    if (captured) {
      captured.body = body;
      captured.contentType = (init.headers as Record<string, string>)[
        'Content-Type'
      ];
    }
    return handler(body);
  }) as unknown as typeof fetch;

  return new ExpensifyClient(config, {
    fetchImpl,
    rateLimiter: noWaitLimiter(),
    sleep: async () => {},
  });
}

describe('ExpensifyClient transport', () => {
  test('form-encodes requestJobDescription with credentials injected', async () => {
    const captured: { body?: string; contentType?: string } = {};
    const client = clientWith(
      () => new Response(JSON.stringify({ responseCode: 200 })),
      captured,
    );

    await client.execute({
      type: 'create',
      inputSettings: { type: 'expenses', employeeEmail: 'a@b.com' },
    });

    expect(captured.contentType).toBe('application/x-www-form-urlencoded');

    const params = new URLSearchParams(captured.body ?? '');
    const job = JSON.parse(params.get('requestJobDescription') ?? '{}');
    expect(job.type).toBe('create');
    expect(job.credentials.partnerUserID).toBe('pid');
    expect(job.credentials.partnerUserSecret).toBe('psecret');
    expect(job.inputSettings.employeeEmail).toBe('a@b.com');
  });

  test('treats 207 partial success as success', async () => {
    const client = clientWith(
      () =>
        new Response(
          JSON.stringify({ responseCode: 207, failedReports: ['R1'] }),
        ),
    );

    const result = await client.execute({
      type: 'update',
      inputSettings: {},
    });
    expect(result.responseCode).toBe(207);
  });

  test('throws ExpensifyApiError on a 410 in the body', async () => {
    const client = clientWith(
      () =>
        new Response(
          JSON.stringify({ responseCode: 410, responseMessage: 'Bad date' }),
        ),
    );

    const error = await client
      .execute({ type: 'create', inputSettings: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExpensifyApiError);
    expect((error as ExpensifyApiError).responseCode).toBe(410);
    expect((error as ExpensifyApiError).responseMessage).toBe('Bad date');
  });

  test('retries a 429 then succeeds', async () => {
    let attempts = 0;
    const client = clientWith(() => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ responseCode: 429 }), {
          status: 429,
        });
      }
      return new Response(JSON.stringify({ responseCode: 200 }));
    });

    const result = await client.execute({ type: 'get', inputSettings: {} });
    expect(attempts).toBe(2);
    expect(result.responseCode).toBe(200);
  });

  test('gives up after repeated 429s', async () => {
    const client = clientWith(
      () => new Response(JSON.stringify({ responseCode: 429 }), { status: 429 }),
    );

    const error = await client
      .execute({ type: 'get', inputSettings: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExpensifyApiError);
    expect((error as ExpensifyApiError).responseCode).toBe(429);
  });

  test('returns raw text for non-JSON export payloads', async () => {
    const client = clientWith(() => new Response('col1,col2\n1,2'));

    const result = await client.execute({
      type: 'download',
      inputSettings: {},
    });
    expect(result.raw).toBe('col1,col2\n1,2');
  });

  test('throws a transport error on a non-JSON HTTP failure', async () => {
    const client = clientWith(
      () => new Response('<html>502</html>', { status: 502 }),
    );

    const error = await client
      .execute({ type: 'get', inputSettings: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExpensifyTransportError);
    expect((error as ExpensifyTransportError).status).toBe(502);
  });

  test('places topLevel sections as siblings of inputSettings, not inside it', async () => {
    // Nesting categories/tags inside inputSettings makes the API return 200
    // and silently discard the change — verified against the live API.
    const captured: { body?: string } = {};
    const client = clientWith(
      () => new Response(JSON.stringify({ responseCode: 200 })),
      captured,
    );

    await client.execute({
      type: 'update',
      inputSettings: { type: 'policy', policyID: 'P1' },
      topLevel: {
        categories: { action: 'merge', data: [{ name: 'C1' }] },
      },
    });

    const params = new URLSearchParams(captured.body ?? '');
    const job = JSON.parse(params.get('requestJobDescription') ?? '{}');

    expect(job.categories).toBeDefined();
    expect(job.categories.data[0].name).toBe('C1');
    expect(job.inputSettings.categories).toBeUndefined();
  });

  test('sends data in a sibling form field with dataSource', async () => {
    const captured: { body?: string } = {};
    const client = clientWith(
      () => new Response(JSON.stringify({ responseCode: 200 })),
      captured,
    );

    await client.execute({
      type: 'update',
      dataSource: 'request',
      inputSettings: { type: 'employees', entity: 'generic' },
      data: [{ employeeEmail: 'a@b.com' }],
    });

    const params = new URLSearchParams(captured.body ?? '');
    const job = JSON.parse(params.get('requestJobDescription') ?? '{}');
    const data = JSON.parse(params.get('data') ?? '[]');

    expect(job.dataSource).toBe('request');
    expect(job.inputSettings.entity).toBe('generic');
    // The roster travels in its own form field, not inside the job JSON.
    expect(job.data).toBeUndefined();
    expect(data[0].employeeEmail).toBe('a@b.com');
  });

  test('redacted job description masks the secret', () => {
    const client = clientWith(() => new Response('{}'));
    const redacted = client.buildRedactedJobDescription({
      type: 'get',
      inputSettings: {},
    });

    expect(JSON.stringify(redacted)).not.toContain('psecret');
  });
});
