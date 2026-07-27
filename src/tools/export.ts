import { z } from 'zod';
import { defineTool } from './types.js';
import { dateSchema } from '../lib/schemas.js';

/**
 * Export jobs run in two steps: a `file`/`reconciliation` job returns a
 * generated filename, then a `download` job retrieves its contents.
 */

const OUTPUT_FORMATS = ['csv', 'xls', 'xlsx', 'txt', 'pdf', 'json'] as const;

const REPORT_STATES = [
  'OPEN',
  'SUBMITTED',
  'APPROVED',
  'REIMBURSED',
  'ARCHIVED',
] as const;

/** Minimal CSV template covering the fields most reconciliations need. */
const DEFAULT_TEMPLATE = `<#list reports as report>
<#list report.transactionList as expense>
\${report.reportID},\${report.reportName},\${report.status},\${expense.created},\${expense.merchant},\${expense.amount / 100},\${expense.currency},\${expense.category!""},\${expense.tag!""}
</#list>
</#list>`;

export const exportReports = defineTool({
  name: 'expensify_export_reports',
  description:
    'Start an export of expense reports and return the generated filename. ' +
    'Filter by report IDs, date range, or approval state. Pass the returned ' +
    'filename to expensify_download_file to get the contents. Supply a ' +
    'freemarker template to control the columns, or omit it for a default ' +
    'CSV of reportID, name, status, date, merchant, amount, currency, ' +
    'category and tag.',
  mutating: false,
  inputSchema: {
    reportIDList: z
      .array(z.string())
      .optional()
      .describe('Specific report IDs to export'),
    startDate: dateSchema
      .optional()
      .describe('Include reports on or after this date'),
    endDate: dateSchema
      .optional()
      .describe('Include reports on or before this date'),
    approvedOnly: z.boolean().optional(),
    state: z
      .array(z.enum(REPORT_STATES))
      .optional()
      .describe('Filter to these report states'),
    outputFormat: z.enum(OUTPUT_FORMATS).optional().describe('Defaults to csv'),
    template: z
      .string()
      .optional()
      .describe('Freemarker template controlling output columns'),
    policyIDList: z
      .array(z.string())
      .optional()
      .describe('Limit the export to these policies'),
  },
  handler: async (args, { client }) => {
    const filters: Record<string, unknown> = {};
    if (args.reportIDList?.length) {
      filters.reportIDList = args.reportIDList.join(',');
    }
    if (args.startDate) filters.startDate = args.startDate;
    if (args.endDate) filters.endDate = args.endDate;
    if (args.approvedOnly !== undefined) {
      filters.approvedOnly = args.approvedOnly;
    }
    if (args.state?.length) filters.state = args.state.join(',');
    if (args.policyIDList?.length) {
      filters.policyIDList = args.policyIDList;
    }

    const inputSettings: Record<string, unknown> = {
      type: 'combinedReportData',
      filters,
      fileExtension: args.outputFormat ?? 'csv',
    };
    if (args.state?.length) inputSettings.reportState = args.state.join(',');

    return client.execute({
      type: 'file',
      template: args.template ?? DEFAULT_TEMPLATE,
      inputSettings,
    });
  },
});

export const exportReconciliation = defineTool({
  name: 'expensify_export_card_reconciliation',
  description:
    'Export company card transactions for a given feed and date range, ' +
    'including transactions not yet attached to a report. Returns a filename ' +
    'to pass to expensify_download_file.',
  mutating: false,
  inputSchema: {
    domainName: z.string().min(1).describe('Card domain, e.g. "example.com"'),
    startDate: dateSchema,
    endDate: dateSchema,
    feedName: z
      .string()
      .optional()
      .describe('Specific card feed; omit for all feeds on the domain'),
    outputFormat: z.enum(OUTPUT_FORMATS).optional().describe('Defaults to csv'),
    template: z.string().optional().describe('Freemarker template'),
  },
  handler: async (args, { client }) => {
    const inputSettings: Record<string, unknown> = {
      type: 'combinedReportData',
      domainName: args.domainName,
      startDate: args.startDate,
      endDate: args.endDate,
      fileExtension: args.outputFormat ?? 'csv',
    };
    if (args.feedName) inputSettings.feedName = args.feedName;

    return client.execute({
      type: 'reconciliation',
      template: args.template ?? DEFAULT_TEMPLATE,
      inputSettings,
    });
  },
});

export const downloadFile = defineTool({
  name: 'expensify_download_file',
  description:
    'Download the contents of a file produced by expensify_export_reports or ' +
    'expensify_export_card_reconciliation, using the filename those tools ' +
    'return.',
  mutating: false,
  inputSchema: {
    fileName: z
      .string()
      .min(1)
      .describe('Filename returned by a previous export job'),
    fileSystem: z
      .enum(['integrationServer', 'reportExporter'])
      .optional()
      .describe('Defaults to integrationServer'),
  },
  handler: async (args, { client }) =>
    client.execute({
      type: 'download',
      inputSettings: {
        type: 'file',
        fileName: args.fileName,
        fileSystem: args.fileSystem ?? 'integrationServer',
      },
    }),
});

export const exportTools = [exportReports, exportReconciliation, downloadFile];
