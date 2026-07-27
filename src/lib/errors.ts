/**
 * Every custom error here declares an explicit constructor and assigns its own
 * fields. Subclassing Error without one silently drops the extra properties.
 */

export class ExpensifyApiError extends Error {
  readonly responseCode: number;
  readonly responseMessage: string;
  readonly raw: unknown;
  /** Which job produced this, so the hint can be specific. */
  readonly jobKind: string | undefined;

  constructor(
    responseCode: number,
    responseMessage: string,
    raw: unknown,
    jobKind?: string,
  ) {
    super(`Expensify API error ${responseCode}: ${responseMessage}`);
    this.name = 'ExpensifyApiError';
    this.responseCode = responseCode;
    this.responseMessage = responseMessage;
    this.raw = raw;
    this.jobKind = jobKind;
    Object.setPrototypeOf(this, ExpensifyApiError.prototype);
  }
}

export class ExpensifyTransportError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'ExpensifyTransportError';
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, ExpensifyTransportError.prototype);
  }
}

/** A write was refused locally — the request never reached Expensify. */
export class WriteGuardError extends Error {
  readonly reason: 'dry-run' | 'policy-not-allowed' | 'batch-too-large';
  readonly detail: unknown;

  constructor(
    reason: 'dry-run' | 'policy-not-allowed' | 'batch-too-large',
    message: string,
    detail?: unknown,
  ) {
    super(message);
    this.name = 'WriteGuardError';
    this.reason = reason;
    this.detail = detail;
    Object.setPrototypeOf(this, WriteGuardError.prototype);
  }
}
