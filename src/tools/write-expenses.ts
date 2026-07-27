import { z } from 'zod';
import { defineTool } from './types.js';
import { executeWrite } from '../lib/write-guard.js';
import {
  emailSchema,
  policyIDSchema,
  transactionSchema,
} from '../lib/schemas.js';

export const createExpenses = defineTool({
  name: 'expensify_create_expenses',
  description:
    'Create one or more expenses on a user account. Amounts are INTEGER CENTS ' +
    '(1234 = $12.34) and dates must be yyyy-MM-dd. Category and tag values must ' +
    'already exist on the policy — call expensify_get_policy first to check. ' +
    'Set externalID per expense to make re-runs traceable. Expenses can be ' +
    'attached to an existing report via reportID, or left standalone.',
  mutating: true,
  inputSchema: {
    employeeEmail: emailSchema.describe(
      'Account the expenses are created on',
    ),
    transactionList: z
      .array(transactionSchema)
      .min(1)
      .describe('Expenses to create'),
  },
  handler: async (args, { client, config }) => {
    const policyIDs = [
      ...new Set(
        args.transactionList
          .map((t) => t.policyID)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];

    const total = args.transactionList.reduce((sum, t) => sum + t.amount, 0);

    return executeWrite(
      client,
      config,
      {
        type: 'create',
        inputSettings: {
          type: 'expenses',
          employeeEmail: args.employeeEmail,
          transactionList: args.transactionList,
        },
      },
      {
        policyIDs,
        batchSize: args.transactionList.length,
        summary:
          `Create ${args.transactionList.length} expense(s) for ` +
          `${args.employeeEmail} totalling ${formatCents(total)} ` +
          `(sum across currencies, shown unconverted)`,
      },
    );
  },
});

export const createReport = defineTool({
  name: 'expensify_create_report',
  description:
    'Create an expense report on a policy, optionally with expenses attached ' +
    'in the same call. Returns the new reportID. Note: this creates the report ' +
    'in an unsubmitted state — the Expensify API cannot submit it for approval ' +
    'or approve it. Amounts are integer cents; dates are yyyy-MM-dd.',
  mutating: true,
  inputSchema: {
    employeeEmail: emailSchema.describe('Account the report is created on'),
    policyID: policyIDSchema,
    title: z.string().min(1).describe('Report title'),
    fields: z
      .record(z.string())
      .optional()
      .describe('Custom report field values, keyed by field name'),
    expenses: z
      .array(transactionSchema)
      .optional()
      .describe('Expenses to create and attach to the new report'),
  },
  handler: async (args, { client, config }) => {
    const report: Record<string, unknown> = { title: args.title };
    if (args.fields) report.fields = args.fields;

    const inputSettings: Record<string, unknown> = {
      type: 'report',
      employeeEmail: args.employeeEmail,
      policyID: args.policyID,
      report,
    };
    if (args.expenses?.length) inputSettings.expenses = args.expenses;

    return executeWrite(
      client,
      config,
      { type: 'create', inputSettings },
      {
        policyIDs: [args.policyID],
        batchSize: args.expenses?.length ?? 0,
        summary:
          `Create report "${args.title}" on policy ${args.policyID} for ` +
          `${args.employeeEmail} with ${args.expenses?.length ?? 0} expense(s)`,
      },
    );
  },
});

export const markReportsReimbursed = defineTool({
  name: 'expensify_mark_reports_reimbursed',
  description:
    'Mark already-APPROVED reports as REIMBURSED. This records that payment ' +
    'happened outside Expensify — it does NOT move money and does NOT approve ' +
    'anything. Reports not already in Approved state will be rejected by the ' +
    'API. This is the only report-status transition the API supports.',
  mutating: true,
  inputSchema: {
    reportIDList: z
      .array(z.string().min(1))
      .min(1)
      .describe('IDs of approved reports to mark reimbursed'),
    paymentSource: z
      .string()
      .optional()
      .describe('Free-text payment source label, e.g. "ADP"'),
  },
  handler: async (args, { client, config }) => {
    const inputSettings: Record<string, unknown> = {
      type: 'reportStatus',
      status: 'REIMBURSED',
      filters: { reportIDList: args.reportIDList.join(',') },
    };
    if (args.paymentSource) inputSettings.paymentSource = args.paymentSource;

    return executeWrite(
      client,
      config,
      { type: 'update', inputSettings },
      {
        batchSize: args.reportIDList.length,
        summary:
          `Mark ${args.reportIDList.length} report(s) as REIMBURSED` +
          (args.paymentSource ? ` via ${args.paymentSource}` : '') +
          `: ${args.reportIDList.join(', ')}`,
      },
    );
  },
});

function formatCents(cents: number): string {
  return `${(cents / 100).toFixed(2)}`;
}

export const expenseWriteTools = [
  createExpenses,
  createReport,
  markReportsReimbursed,
];
