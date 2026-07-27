import { z } from 'zod';
import { defineTool } from './types.js';
import { executeWrite } from '../lib/write-guard.js';
import {
  categorySchema,
  centsSchema,
  emailSchema,
  policyIDSchema,
  tagGroupSchema,
  updateActionSchema,
} from '../lib/schemas.js';

export const createPolicy = defineTool({
  name: 'expensify_create_policy',
  description:
    'Create a new Expensify policy (workspace). Returns the new policyID.',
  mutating: true,
  inputSchema: {
    policyName: z.string().min(1).describe('Name for the new workspace'),
    type: z
      .enum(['team', 'corporate'])
      .optional()
      .describe('Policy tier. Defaults to team'),
  },
  handler: async (args, { client, config }) =>
    executeWrite(
      client,
      config,
      {
        type: 'create',
        inputSettings: {
          type: 'policy',
          policyName: args.policyName,
          policyType: args.type ?? 'team',
        },
      },
      {
        summary: `Create ${args.type ?? 'team'} policy "${args.policyName}"`,
      },
    ),
});

export const updatePolicyCategories = defineTool({
  name: 'expensify_update_policy_categories',
  description:
    'Add, update, or replace expense categories on a policy. action="merge" ' +
    'upserts the supplied categories and leaves others untouched. ' +
    'action="replace" DELETES every category not listed in this call — use ' +
    'with care. maxExpenseAmount is in integer cents.',
  mutating: true,
  inputSchema: {
    policyID: policyIDSchema,
    action: updateActionSchema,
    categories: z.array(categorySchema).min(1),
  },
  handler: async (args, { client, config }) =>
    executeWrite(
      client,
      config,
      {
        type: 'update',
        inputSettings: { type: 'policy', policyID: args.policyID },
        topLevel: {
          categories: { action: args.action, data: args.categories },
        },
      },
      {
        policyIDs: [args.policyID],
        batchSize: args.categories.length,
        summary:
          `${args.action === 'replace' ? 'REPLACE (destructive)' : 'Merge'} ` +
          `${args.categories.length} categor(ies) on policy ${args.policyID}`,
      },
    ),
});

export const updatePolicyTags = defineTool({
  name: 'expensify_update_policy_tags',
  description:
    'Add, update, or replace tags on a policy. Tags are grouped into lists; ' +
    'each group has a name and its own tags array.\n\n' +
    'DATA LOSS WARNING (verified against the live API): a tag group is ' +
    'replaced WHOLESALE even with action="merge". Any tag already in the group ' +
    'but absent from your payload is DELETED. Always call ' +
    'expensify_get_policy first, then send the full existing tag list plus ' +
    'your additions. action="merge" only protects OTHER groups, not tags ' +
    'within the groups you send.',
  mutating: true,
  inputSchema: {
    policyID: policyIDSchema,
    action: updateActionSchema,
    tagGroups: z
      .array(tagGroupSchema)
      .min(1)
      .describe('Tag lists to apply to the policy'),
  },
  handler: async (args, { client, config }) => {
    const tagCount = args.tagGroups.reduce((n, g) => n + g.tags.length, 0);

    return executeWrite(
      client,
      config,
      {
        type: 'update',
        inputSettings: { type: 'policy', policyID: args.policyID },
        topLevel: {
          tags: { action: args.action, data: args.tagGroups },
        },
      },
      {
        policyIDs: [args.policyID],
        batchSize: tagCount,
        summary:
          `${args.action === 'replace' ? 'REPLACE (destructive)' : 'Merge'} ` +
          `${tagCount} tag(s) across ${args.tagGroups.length} group(s) on ` +
          `policy ${args.policyID}`,
      },
    );
  },
});

/**
 * The advanced employee updater does not read employees from inputSettings.
 * It requires dataSource: "request", entity: "generic", and the roster in a
 * sibling `data` form field. employeeEmail, managerEmail, employeeID and
 * policyID are all required per record.
 */
const employeeSchema = z.object({
  employeeEmail: emailSchema,
  managerEmail: emailSchema.describe(
    'Approval manager. Required — use the employee themselves if they have none',
  ),
  employeeID: z
    .string()
    .min(1)
    .describe('Your identifier for this employee. Required'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  role: z
    .enum(['admin', 'auditor', 'user'])
    .optional()
    .describe('Policy role. Defaults to user'),
  customField1: z.string().optional(),
  customField2: z.string().optional(),
  approvalLimit: centsSchema
    .optional()
    .describe('Approval limit in integer cents'),
  overLimitApprover: emailSchema.optional(),
  limitApprover: emailSchema.optional(),
  approvesTo: emailSchema.optional().describe('Who this employee approves to'),
  workerStatus: z.string().optional(),
  domainGroupID: z.string().optional(),
  additionalPolicyIDs: z.array(z.string()).optional(),
  defaultTags: z.record(z.string()).optional(),
});

export const updateEmployees = defineTool({
  name: 'expensify_update_employees',
  description:
    'Add or update members on a policy, including role, manager, approval ' +
    'limits and routing. Members are matched by email and updated in place. ' +
    'employeeEmail, managerEmail and employeeID are required for each record. ' +
    'To remove someone use expensify_remove_employees.',
  mutating: true,
  inputSchema: {
    policyID: policyIDSchema,
    employees: z.array(employeeSchema).min(1),
    notifyEmails: z
      .array(emailSchema)
      .optional()
      .describe('Email these addresses a summary when the job finishes'),
  },
  handler: async (args, { client, config }) => {
    const request = {
      type: 'update' as const,
      dataSource: 'request' as const,
      inputSettings: { type: 'employees', entity: 'generic' },
      data: args.employees.map((employee) => ({
        ...employee,
        policyID: args.policyID,
      })),
      ...(args.notifyEmails?.length
        ? {
            topLevel: {
              onFinish: [
                {
                  actionName: 'email',
                  recipients: args.notifyEmails.join(','),
                },
              ],
            },
          }
        : {}),
    };

    return executeWrite(client, config, request, {
      policyIDs: [args.policyID],
      batchSize: args.employees.length,
      summary:
        `Add/update ${args.employees.length} employee(s) on policy ` +
        `${args.policyID}: ` +
        args.employees.map((e) => e.employeeEmail).join(', '),
    });
  },
});

export const removeEmployees = defineTool({
  name: 'expensify_remove_employees',
  description:
    'Remove members from a policy. Sets isTerminated on each record, which is ' +
    'how the API removes someone from their assigned policy.',
  mutating: true,
  inputSchema: {
    policyID: policyIDSchema,
    employees: z
      .array(
        z.object({
          employeeEmail: emailSchema,
          managerEmail: emailSchema.describe('Required even on removal'),
          employeeID: z.string().min(1).describe('Required even on removal'),
        }),
      )
      .min(1),
    shouldRemoveFromUnassignedPolicies: z
      .boolean()
      .optional()
      .describe('Also remove them from policies not listed here'),
  },
  handler: async (args, { client, config }) => {
    const data = args.employees.map((employee) => ({
      ...employee,
      policyID: args.policyID,
      isTerminated: true,
      ...(args.shouldRemoveFromUnassignedPolicies !== undefined
        ? {
            shouldRemoveFromUnassignedPolicies:
              args.shouldRemoveFromUnassignedPolicies,
          }
        : {}),
    }));

    return executeWrite(
      client,
      config,
      {
        type: 'update',
        dataSource: 'request',
        inputSettings: { type: 'employees', entity: 'generic' },
        data,
      },
      {
        policyIDs: [args.policyID],
        batchSize: args.employees.length,
        summary:
          `REMOVE ${args.employees.length} employee(s) from policy ` +
          `${args.policyID}: ` +
          args.employees.map((e) => e.employeeEmail).join(', '),
      },
    );
  },
});

export const updateTagApprovers = defineTool({
  name: 'expensify_update_tag_approvers',
  description:
    'Set or clear the approver for individual tags on a policy. Pass an empty ' +
    'string as approver to clear one. Only single-level tags are supported. ' +
    'Tag names must already exist on the policy.',
  mutating: true,
  inputSchema: {
    policyID: policyIDSchema,
    tagApprovers: z
      .array(
        z.object({
          name: z.string().min(1).describe('Existing tag name'),
          approver: z
            .string()
            .describe('Approver email, or empty string to clear'),
        }),
      )
      .min(1),
  },
  handler: async (args, { client, config }) =>
    executeWrite(
      client,
      config,
      {
        type: 'update',
        inputSettings: {
          type: 'tagApprovers',
          policyID: args.policyID,
          tagApprovers: args.tagApprovers,
        },
      },
      {
        policyIDs: [args.policyID],
        batchSize: args.tagApprovers.length,
        summary:
          `Set approvers for ${args.tagApprovers.length} tag(s) on policy ` +
          `${args.policyID}`,
      },
    ),
});

const ruleActionsSchema = z
  .object({
    tag: z.string().optional().describe('Tag to auto-apply'),
    defaultBillable: z.boolean().optional(),
  })
  .refine((v) => v.tag !== undefined || v.defaultBillable !== undefined, {
    message: 'At least one of tag or defaultBillable must be set',
  });

export const createExpenseRule = defineTool({
  name: 'expensify_create_expense_rule',
  description:
    'Create an expense rule that automatically applies a tag or billable ' +
    'status for an employee on a policy.',
  mutating: true,
  inputSchema: {
    policyID: policyIDSchema,
    employeeEmail: emailSchema.describe('Employee the rule applies to'),
    actions: ruleActionsSchema,
  },
  handler: async (args, { client, config }) =>
    executeWrite(
      client,
      config,
      {
        type: 'create',
        inputSettings: {
          type: 'expenseRules',
          policyID: args.policyID,
          employeeEmail: args.employeeEmail,
          actions: args.actions,
        },
      },
      {
        policyIDs: [args.policyID],
        summary:
          `Create expense rule for ${args.employeeEmail} on policy ` +
          `${args.policyID}`,
      },
    ),
});

export const updateExpenseRule = defineTool({
  name: 'expensify_update_expense_rule',
  description:
    'Modify an existing expense rule by its ruleID.',
  mutating: true,
  inputSchema: {
    policyID: policyIDSchema,
    ruleID: z.number().int().describe('ID of the rule to modify'),
    employeeEmail: emailSchema,
    actions: ruleActionsSchema,
  },
  handler: async (args, { client, config }) =>
    executeWrite(
      client,
      config,
      {
        type: 'update',
        inputSettings: {
          type: 'expenseRules',
          policyID: args.policyID,
          ruleID: args.ruleID,
          employeeEmail: args.employeeEmail,
          actions: args.actions,
        },
      },
      {
        policyIDs: [args.policyID],
        summary: `Update expense rule ${args.ruleID} on policy ${args.policyID}`,
      },
    ),
});

export const policyWriteTools = [
  createPolicy,
  updatePolicyCategories,
  updatePolicyTags,
  updateEmployees,
  removeEmployees,
  updateTagApprovers,
  createExpenseRule,
  updateExpenseRule,
];
