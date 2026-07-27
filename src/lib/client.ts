import type { Config } from './config.js';
import {
  ExpensifyApiError,
  ExpensifyTransportError,
} from './errors.js';
import { RateLimiter } from './rate-limiter.js';

export const INTEGRATION_SERVER_URL =
  'https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations';

export type JobType = 'create' | 'update' | 'get' | 'file' | 'download' | 'reconciliation';

export interface JobRequest {
  type: JobType;
  inputSettings: Record<string, unknown>;
  /** Only used by export jobs, which take a freemarker template. */
  template?: string;
  /**
   * Some jobs (notably the advanced employee updater) carry their payload in a
   * sibling `data` form field rather than inside inputSettings, and pair it
   * with dataSource: "request".
   */
  data?: unknown;
  dataSource?: 'request' | 'download' | 'sftp';
  /**
   * Sections the API expects as top-level siblings of inputSettings rather
   * than nested inside it — categories, tags and reportFields on the policy
   * updater, and onFinish hooks. Nesting them instead yields a 200 that
   * silently does nothing.
   */
  topLevel?: Record<string, unknown>;
}

export interface ExpensifyResponse {
  responseCode?: number;
  responseMessage?: string;
  [key: string]: unknown;
}

/** 200 = success, 207 = partial success (check failed/skipped collections). */
const SUCCESS_CODES = new Set([200, 207]);

const MAX_429_RETRIES = 3;

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  rateLimiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
}

export class ExpensifyClient {
  private readonly config: Config;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: Config, options: ClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.limiter = options.rateLimiter ?? new RateLimiter();
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Builds the job payload exactly as the API expects it. Credentials are
   * injected here so no caller has to handle them.
   */
  buildJobDescription(request: JobRequest): Record<string, unknown> {
    const job: Record<string, unknown> = {
      type: request.type,
      credentials: {
        partnerUserID: this.config.partnerUserID,
        partnerUserSecret: this.config.partnerUserSecret,
      },
      inputSettings: request.inputSettings,
      ...(request.topLevel ?? {}),
    };
    if (request.dataSource !== undefined) job.dataSource = request.dataSource;
    return job;
  }

  /**
   * Same shape as buildJobDescription but with the secret masked — safe to
   * return to the model in dry-run previews and error messages.
   */
  buildRedactedJobDescription(request: JobRequest): Record<string, unknown> {
    const job: Record<string, unknown> = {
      type: request.type,
      credentials: {
        partnerUserID: this.config.partnerUserID,
        partnerUserSecret: '***redacted***',
      },
      inputSettings: request.inputSettings,
      ...(request.topLevel ?? {}),
    };
    if (request.dataSource !== undefined) job.dataSource = request.dataSource;
    if (request.data !== undefined) job.data = request.data;
    return job;
  }

  async execute(request: JobRequest): Promise<ExpensifyResponse> {
    let attempt = 0;

    for (;;) {
      await this.limiter.acquire();

      const body = new URLSearchParams();
      body.set(
        'requestJobDescription',
        JSON.stringify(this.buildJobDescription(request)),
      );
      if (request.template !== undefined) {
        body.set('template', request.template);
      }
      if (request.data !== undefined) {
        body.set('data', JSON.stringify(request.data));
      }

      let response: Response;
      try {
        response = await this.fetchImpl(INTEGRATION_SERVER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });
      } catch (cause) {
        throw new ExpensifyTransportError(
          `Network failure calling Expensify: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }

      const text = await response.text();

      // Rate limiting can surface as an HTTP status or as a responseCode in an
      // otherwise-200 body, so both paths funnel into the same retry.
      const parsed = tryParseJson(text);
      const bodyCode =
        parsed && typeof parsed.responseCode === 'number'
          ? parsed.responseCode
          : undefined;
      const isRateLimited = response.status === 429 || bodyCode === 429;

      if (isRateLimited && attempt < MAX_429_RETRIES) {
        attempt += 1;
        // The documented windows are 10s and 60s; backing off in that shape
        // beats a tight retry that just burns the next window too.
        await this.sleep(attempt * 10_000);
        continue;
      }

      if (!response.ok && parsed === undefined) {
        throw new ExpensifyTransportError(
          `Expensify returned HTTP ${response.status}`,
          response.status,
          truncate(text),
        );
      }

      if (parsed === undefined) {
        // Export/download jobs legitimately return non-JSON payloads.
        return { raw: text };
      }

      if (bodyCode !== undefined && !SUCCESS_CODES.has(bodyCode)) {
        throw new ExpensifyApiError(
          bodyCode,
          typeof parsed.responseMessage === 'string'
            ? parsed.responseMessage
            : 'Unknown error',
          parsed,
          request.type,
        );
      }

      return parsed;
    }
  }
}

function tryParseJson(text: string): ExpensifyResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null) return undefined;
    return value as ExpensifyResponse;
  } catch {
    return undefined;
  }
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
