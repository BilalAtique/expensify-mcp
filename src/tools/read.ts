import { z } from 'zod';
import { defineTool } from './types.js';
import { policyIDSchema } from '../lib/schemas.js';

const POLICY_FIELDS = [
  'categories',
  'reportFields',
  'tags',
  'tax',
  'employees',
] as const;

export const listPolicies = defineTool({
  name: 'expensify_list_policies',
  description:
    'List Expensify policies (workspaces) the authenticated account can see. ' +
    'Returns id, name, owner, role, type and output currency for each. Start ' +
    'here when you need a policy ID for any other tool.',
  mutating: false,
  inputSchema: {
    adminOnly: z
      .boolean()
      .optional()
      .describe('Only return policies where the account is an admin'),
    userEmail: z
      .string()
      .email()
      .optional()
      .describe('Fetch policies for another user the account can access'),
  },
  handler: async (args, { client }) => {
    const inputSettings: Record<string, unknown> = { type: 'policyList' };
    if (args.adminOnly !== undefined) inputSettings.adminOnly = args.adminOnly;
    if (args.userEmail !== undefined) inputSettings.userEmail = args.userEmail;

    return client.execute({ type: 'get', inputSettings });
  },
});

export const getPolicy = defineTool({
  name: 'expensify_get_policy',
  description:
    'Fetch configuration for one or more policies: categories, tags, report ' +
    'fields, tax rates, and the employee roster. Use this to discover valid ' +
    'category and tag names before creating expenses, since the API rejects ' +
    'values that do not already exist on the policy.',
  mutating: false,
  inputSchema: {
    policyIDList: z
      .array(policyIDSchema)
      .min(1)
      .describe('Policy IDs to fetch'),
    fields: z
      .array(z.enum(POLICY_FIELDS))
      .optional()
      .describe(
        'Which sections to return. Defaults to all of: ' +
          POLICY_FIELDS.join(', '),
      ),
  },
  handler: async (args, { client }) =>
    client.execute({
      type: 'get',
      inputSettings: {
        type: 'policy',
        policyIDList: args.policyIDList,
        fields: args.fields ?? [...POLICY_FIELDS],
      },
    }),
});

export const getDomainCards = defineTool({
  name: 'expensify_get_domain_cards',
  description:
    'List corporate/domain card assignments, including bank source and import ' +
    'history. Requires domain admin rights on the account.',
  mutating: false,
  inputSchema: {
    domainName: z
      .string()
      .min(1)
      .describe('Domain to query, e.g. "example.com"'),
  },
  handler: async (args, { client }) =>
    client.execute({
      type: 'get',
      inputSettings: {
        type: 'domainCardList',
        domainName: args.domainName,
      },
    }),
});

export const readTools = [listPolicies, getPolicy, getDomainCards];
