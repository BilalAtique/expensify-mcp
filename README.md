# expensify-mcp

Full-capability MCP server for Expensify, built on the [Integration Server API](https://integrations.expensify.com/Integration-Server/doc/).

Expensify's official hosted MCP (`expensify.com/mcp`) is deliberately read-only — it "cannot approve transactions, edit data, or move money." This server adds the write surface the Integration Server API actually exposes: creating expenses and reports, managing policies, categories, tags, members, approval routing, and expense rules.

## What this can and cannot do

**Can do (17 tools):**

| Tool | Type | Purpose |
| --- | --- | --- |
| `expensify_list_policies` | read | List workspaces + IDs |
| `expensify_get_policy` | read | Categories, tags, report fields, tax rates, employees |
| `expensify_get_domain_cards` | read | Corporate card assignments |
| `expensify_export_reports` | read | Export reports → filename |
| `expensify_export_card_reconciliation` | read | Export card transactions → filename |
| `expensify_download_file` | read | Fetch an exported file's contents |
| `expensify_create_expenses` | write | Create expenses on an account |
| `expensify_create_report` | write | Create a report, optionally with expenses |
| `expensify_mark_reports_reimbursed` | write | Approved → Reimbursed |
| `expensify_create_policy` | write | New workspace |
| `expensify_update_policy_categories` | write | Merge/replace categories |
| `expensify_update_policy_tags` | write | Merge/replace tag groups |
| `expensify_update_employees` | write | Add/update members, roles, routing |
| `expensify_remove_employees` | write | Remove members |
| `expensify_update_tag_approvers` | write | Per-tag approvers |
| `expensify_create_expense_rule` | write | Auto-tag / billable rules |
| `expensify_update_expense_rule` | write | Modify a rule |

**Cannot do — no supported API exists:**

- **Approving a report.** There is no approve endpoint. `mark_reports_reimbursed` only moves `Approved → Reimbursed`; getting a report *to* Approved is app-only.
- **Moving money.** Marking Reimbursed is a bookkeeping flag recording that you paid outside Expensify. No ACH, no payment.
- Submitting a report into the approval workflow, SmartScan OCR, card issuance/limits, bank account setup, most workspace settings, Concierge chat.

The practical ceiling is **"create and configure everything, read everything, but cannot approve or move money."**

## Setup

```bash
npm install
npm run build
```

Generate credentials at <https://www.expensify.com/tools/integrations/>. They are shown once.

```bash
cp .env.example .env   # then fill in the two credential values
```

## Safety model

These tools write to real financial records. Expensify has no sandbox tier, so protection is enforced locally:

- **`EXPENSIFY_DRY_RUN` defaults to `true`.** Mutating tools return a preview of the exact payload instead of sending it. Only the literal string `false` disables this — a typo fails closed.
- **`EXPENSIFY_ALLOWED_POLICY_IDS`** (optional) refuses any mutation touching a policy outside the list.
- **`EXPENSIFY_MAX_BATCH_SIZE`** (default 100) caps records per write.
- Guards run *before* the dry-run check, so a blocked write is never even previewed.
- The partner secret is redacted from every preview and error message.

Start with dry-run on, read the previews, then flip it off for the specific operation you intend.

## Hosted deployment (optional)

The server also ships an HTTP transport at `api/mcp.ts`, so it can run on Vercel
and be added as a custom connector instead of a local subprocess.

**This hosts *your* credentials behind *your* token — it is not multi-tenant.**
Expensify's Integration Server API has no OAuth and no delegated access, so
there is no way for other users to connect their own accounts through a hosted
instance. Anyone with the URL *and* the bearer token acts as the account whose
credentials are in the environment.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `EXPENSIFY_PARTNER_USER_ID` | Your Expensify credential |
| `EXPENSIFY_PARTNER_USER_SECRET` | Your Expensify credential |
| `MCP_AUTH_TOKEN` | Bearer token gating the endpoint. Generate with `openssl rand -hex 32` |
| `EXPENSIFY_DRY_RUN` | Recommended `true` until you have tested the deployment |

The auth gate **fails closed**: if `MCP_AUTH_TOKEN` is unset, every request is
refused with a 503 rather than exposing an unauthenticated write endpoint.
Requests without a valid `Authorization: Bearer <token>` header get a 401.

Add it as a custom connector with the deployment's `/mcp` URL and the bearer
token. Rotate the token by updating the env var and redeploying.

## Client configuration

Claude Code:

```bash
claude mcp add expensify -- node /absolute/path/to/expensify-mcp/dist/index.js
```

Or in `.mcp.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "expensify": {
      "command": "node",
      "args": ["/absolute/path/to/expensify-mcp/dist/index.js"],
      "env": {
        "EXPENSIFY_PARTNER_USER_ID": "...",
        "EXPENSIFY_PARTNER_USER_SECRET": "...",
        "EXPENSIFY_DRY_RUN": "true"
      }
    }
  }
}
```

## Live verification status

Verified against the real API on 2026-07-27 using a throwaway workspace.

| Tool | Status |
| --- | --- |
| `list_policies` | verified |
| `get_policy` | verified |
| `create_policy` | verified — created the test workspace |
| `create_expenses` | verified |
| `create_report` | verified |
| `update_policy_categories` | verified — persistence confirmed by read-back |
| `update_policy_tags` | verified — see the data-loss warning below |
| `update_tag_approvers` | verified |
| `create_expense_rule` | verified — duplicate correctly rejected on re-run |
| `export_reports` | verified — exported 18 real reports |
| `download_file` | verified — retrieved the exported CSV |
| `update_employees` / `remove_employees` | **untested** — account returns 403 |
| `export_card_reconciliation` | **untested** — needs a card domain |
| `mark_reports_reimbursed` | **untested** — needs an Approved report, unreachable via API |
| `get_domain_cards` | **untested** — needs a verified domain |

Four bugs were found and fixed, every one of them a payload-placement mistake
that this API reports opaquely:

1. **Categories and tags belong at the top level** of the job description, not
   inside `inputSettings`. Nested, the API returns `200` and silently discards
   the change.
2. **The employee updater** needs `dataSource: "request"`, `entity: "generic"`,
   and the roster in a separate `data` form field.
3. **Export jobs need `onReceive.immediateResponse`**, and `fileExtension` goes
   in `outputSettings`, not `inputSettings`. Without it the request blocks and
   then fails with a bare `500` that looks like an outage.
4. **The download job takes `fileName` / `fileSystem` at the top level** and no
   `inputSettings` at all.

All four are regression-tested. The lesson generalises: when this API returns a
`500`, or a `200` that changes nothing, suspect payload placement before
concluding the endpoint is broken or the account is limited. Comparing against
a raw `curl` built straight from the docs is the fastest way to tell.

## Data-loss warning: tag merges

Verified against the live API: **a tag group is replaced wholesale even with
`action: "merge"`.** Sending a group with one tag deletes every other tag in
that group. `merge` only protects groups you did not mention.

Always `expensify_get_policy` first and send the complete tag list plus your
additions. Categories do not behave this way — they genuinely merge.

## API conventions worth knowing

These bite hard, so the schemas enforce them:

- **Amounts are integer cents.** `1234` means $12.34. Floats are rejected outright — passing `12.34` would otherwise post a 100×-wrong expense.
- **Dates are strictly `yyyy-MM-dd`.**
- **Categories and tags must already exist** on the policy. Call `expensify_get_policy` first.
- **`action: "replace"`** on categories/tags deletes everything not in the payload. `"merge"` is the safe default.
- **Rate limits: 5 requests / 10s and 20 / 60s.** Both windows are enforced client-side with a queue; 429s are retried with backoff.
- **`responseCode` 207** means partial success — check `failedReports` / `skippedReports` in the response.

## Development

```bash
npm run dev          # run from source via bun
npm test             # 27 tests
npm run type-check   # tsc --noEmit, clean
npm run build
```

Tests cover the rate limiter's dual-window behavior, the write-guard matrix (dry-run, allowlist, batch cap, secret redaction), transport encoding, and error mapping. The server was additionally smoke-tested over the real MCP stdio protocol.

## Structure

```
src/
  index.ts            # MCP server, tool registration, error formatting
  lib/
    config.ts         # env parsing, fail-closed dry-run
    client.ts         # form-encoded transport, 429 retry, error mapping
    rate-limiter.ts   # dual sliding windows, serialized
    write-guard.ts    # the single chokepoint for all mutations
    errors.ts         # typed errors with explicit constructors
    schemas.ts        # shared Zod schemas (cents, dates, currency)
  tools/
    read.ts           # policy + card reads
    export.ts         # report/reconciliation export + download
    write-expenses.ts # expenses, reports, reimbursement status
    write-policy.ts   # policies, categories, tags, members, rules
```
