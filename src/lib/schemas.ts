import { z } from 'zod';

/** The API rejects anything that is not strictly yyyy-MM-dd. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted yyyy-MM-dd');

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter uppercase ISO code, e.g. USD');

/**
 * Expensify denominates money in integer cents. Accepting a float here is the
 * single easiest way to post a 100x-wrong expense, so it is rejected outright.
 */
export const centsSchema = z
  .number()
  .int('Amount must be an integer number of cents (e.g. 1234 = $12.34)');

export const emailSchema = z.string().email();

export const policyIDSchema = z
  .string()
  .min(1)
  .describe('Expensify policy (workspace) ID');

export const taxSchema = z.object({
  rateID: z.string().describe('Tax rate ID as configured on the policy'),
  amount: centsSchema.optional().describe('Tax amount in cents'),
});

export const transactionSchema = z.object({
  merchant: z.string().min(1).describe('Vendor name'),
  created: dateSchema.describe('Transaction date, yyyy-MM-dd'),
  amount: centsSchema.describe('Amount in cents. 1234 means $12.34'),
  currency: currencySchema.describe('3-letter ISO currency code'),
  externalID: z
    .string()
    .optional()
    .describe('Your own identifier, useful for idempotency and reconciliation'),
  category: z.string().optional().describe('Must already exist on the policy'),
  tag: z.string().optional().describe('Must already exist on the policy'),
  billable: z.boolean().optional(),
  reimbursable: z.boolean().optional(),
  comment: z.string().optional(),
  reportID: z.string().optional().describe('Attach to an existing report'),
  policyID: z.string().optional(),
  tax: taxSchema.optional(),
});

export type Transaction = z.infer<typeof transactionSchema>;

export const categorySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  glCode: z.string().optional(),
  payrollCode: z.string().optional(),
  areCommentsRequired: z.boolean().optional(),
  commentHint: z.string().optional(),
  maxExpenseAmount: centsSchema.optional().describe('In cents'),
});

export const tagSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  glCode: z.string().optional(),
});

export const tagGroupSchema = z.object({
  name: z.string().min(1).describe('Tag group / list name'),
  setRequired: z.boolean().optional(),
  tags: z.array(tagSchema),
});

/**
 * "replace" deletes everything not present in the payload. It is the more
 * destructive of the two, so callers must opt into it explicitly.
 */
export const updateActionSchema = z
  .enum(['merge', 'replace'])
  .describe(
    'merge keeps existing entries and upserts the ones provided; ' +
      'replace deletes every entry not present in this payload',
  );
