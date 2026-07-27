// Exercises each tool against the live API and reports pass/fail per tool.
// Writes are fenced to EXPENSIFY_ALLOWED_POLICY_IDS by the write guard.
//
//   node scripts/live-probe.mjs           # read-only probes
//   node scripts/live-probe.mjs --writes  # includes real writes
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const doWrites = process.argv.includes('--writes');
if (doWrites) process.env.EXPENSIFY_DRY_RUN = 'false';

const { ExpensifyClient } = await import(resolve(root, 'dist/lib/client.js'));
const { loadConfig } = await import(resolve(root, 'dist/lib/config.js'));
const { executeWrite } = await import(resolve(root, 'dist/lib/write-guard.js'));

const config = loadConfig();
const client = new ExpensifyClient(config);

const POLICY_ID = [...config.allowedPolicyIDs][0];
const EMAIL = process.env.EXPENSIFY_PROBE_EMAIL;

if (!POLICY_ID) {
  console.error('No EXPENSIFY_ALLOWED_POLICY_IDS set — refusing to probe.');
  process.exit(1);
}
if (!EMAIL) {
  console.error('Set EXPENSIFY_PROBE_EMAIL to the account email to probe with.');
  process.exit(1);
}

console.log(`policy: ${POLICY_ID}   writes: ${doWrites ? 'LIVE' : 'dry-run'}\n`);

const results = [];

async function probe(name, fn) {
  try {
    const value = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
    return value;
  } catch (error) {
    results.push({ name, ok: false, error: `${error.name}: ${error.message}` });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.name}: ${error.message}`);
    if (error.raw) console.log(`      raw: ${JSON.stringify(error.raw)}`);
    return undefined;
  }
}

const read = (inputSettings) => client.execute({ type: 'get', inputSettings });
const write = (type, inputSettings, summary) =>
  executeWrite(client, config, { type, inputSettings }, {
    policyIDs: [POLICY_ID],
    summary,
  });

// --- reads -----------------------------------------------------------------
await probe('list_policies', () => read({ type: 'policyList' }));

const policy = await probe('get_policy', () =>
  read({
    type: 'policy',
    policyIDList: [POLICY_ID],
    fields: ['categories', 'reportFields', 'tags', 'tax', 'employees'],
  }),
);

// --- writes ----------------------------------------------------------------
await probe('update_policy_categories (merge)', () =>
  write('update', {
    type: 'policy',
    policyID: POLICY_ID,
    categories: {
      action: 'merge',
      data: [{ name: 'MCP Probe Category', enabled: true, glCode: 'MCP-001' }],
    },
  }, 'merge 1 category'),
);

await probe('update_policy_tags (merge)', () =>
  write('update', {
    type: 'policy',
    policyID: POLICY_ID,
    tags: {
      action: 'merge',
      source: 'inline',
      data: [{ name: 'MCP Probe Tags', setRequired: false, tags: [{ name: 'probe-tag', enabled: true }] }],
    },
  }, 'merge 1 tag'),
);

await probe('create_expenses', () =>
  executeWrite(client, config, {
    type: 'create',
    inputSettings: {
      type: 'expenses',
      employeeEmail: EMAIL,
      transactionList: [{
        merchant: 'MCP Probe Merchant',
        created: '2026-07-01',
        amount: 1234,
        currency: 'USD',
        externalID: 'mcp-probe-001',
        comment: 'Created by expensify-mcp live probe',
      }],
    },
  }, { batchSize: 1, summary: 'create 1 expense' }),
);

await probe('create_report', () =>
  write('create', {
    type: 'report',
    employeeEmail: EMAIL,
    policyID: POLICY_ID,
    report: { title: 'MCP Probe Report' },
    expenses: [{
      merchant: 'MCP Probe Report Merchant',
      created: '2026-07-02',
      amount: 5678,
      currency: 'USD',
    }],
  }, 'create report with 1 expense'),
);

await probe('update_employees', () =>
  write('update', {
    type: 'employees',
    policyID: POLICY_ID,
    employees: [{ employeeEmail: EMAIL, role: 'admin' }],
  }, 'update 1 employee'),
);

await probe('update_tag_approvers', () =>
  write('update', {
    type: 'tagApprovers',
    policyID: POLICY_ID,
    tagApprovers: [{ name: 'probe-tag', approver: EMAIL }],
  }, 'set 1 tag approver'),
);

await probe('create_expense_rule', () =>
  write('create', {
    type: 'expenseRules',
    policyID: POLICY_ID,
    employeeEmail: EMAIL,
    actions: { tag: 'probe-tag' },
  }, 'create 1 expense rule'),
);

// --- guard check -----------------------------------------------------------
await probe('write guard blocks foreign policy', async () => {
  try {
    await executeWrite(client, config, {
      type: 'update',
      inputSettings: { type: 'policy', policyID: 'DEADBEEF00000000' },
    }, { policyIDs: ['DEADBEEF00000000'], summary: 'should be blocked' });
  } catch (error) {
    if (error.name === 'WriteGuardError') return 'blocked as expected';
    throw error;
  }
  throw new Error('guard did NOT block a foreign policy');
});

// --- final state -----------------------------------------------------------
const final = await probe('get_policy (after writes)', () =>
  read({ type: 'policy', policyIDList: [POLICY_ID], fields: ['categories', 'tags', 'employees'] }),
);

console.log('\n--- summary ---');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
for (const r of results.filter((r) => !r.ok)) console.log(`  FAIL ${r.name}: ${r.error}`);

if (final) {
  console.log('\n--- final policy state ---');
  console.log(JSON.stringify(final, null, 2).slice(0, 2500));
}
