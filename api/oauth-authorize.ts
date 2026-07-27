import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CODE_TTL_SECONDS,
  OWNER_SUBJECT,
  OAuthConfigError,
  canonicalResource,
  loadOAuthEnv,
} from '../src/lib/oauth-config.js';
import {
  constantTimeEquals,
  deriveClientId,
  issueToken,
} from '../src/lib/oauth-store.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readForm(
  req: IncomingMessage & { body?: unknown },
): Promise<URLSearchParams> {
  if (typeof req.body === 'string') {
    return Promise.resolve(new URLSearchParams(req.body));
  }
  if (req.body && typeof req.body === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      params.set(k, String(v));
    }
    return Promise.resolve(params);
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => resolve(new URLSearchParams(raw)));
  });
}

function consentPage(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  error?: string;
}): string {
  const err = params.error
    ? `<p class="err">${escapeHtml(params.error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Authorize Expensify MCP</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
   max-width:26rem;margin:12vh auto;padding:0 1.5rem;color:#18181b}
 h1{font-size:1.35rem;margin-bottom:.25rem}
 .sub{color:#71717a;font-size:.9rem;margin-top:0}
 .box{border:1px solid #e4e4e7;border-radius:10px;padding:1.25rem;margin:1.5rem 0}
 label{display:block;font-size:.85rem;font-weight:600;margin-bottom:.4rem}
 input{width:100%;padding:.6rem .7rem;font-size:1rem;border:1px solid #d4d4d8;
   border-radius:7px;box-sizing:border-box}
 button{width:100%;margin-top:1rem;padding:.7rem;font-size:1rem;font-weight:600;
   background:#18181b;color:#fff;border:0;border-radius:7px;cursor:pointer}
 .err{background:#fef2f2;color:#b91c1c;padding:.6rem .8rem;border-radius:7px;
   font-size:.9rem}
 .meta{font-size:.8rem;color:#71717a;word-break:break-all}
 @media(prefers-color-scheme:dark){
  body{background:#09090b;color:#fafafa}
  .box{border-color:#27272a}
  input{background:#18181b;border-color:#3f3f46;color:#fafafa}
  button{background:#fafafa;color:#18181b}
  .err{background:#450a0a;color:#fca5a5}
 }
</style></head><body>
<h1>Authorize access</h1>
<p class="sub">Expensify MCP server</p>
${err}
<div class="box">
  <p style="margin-top:0;font-size:.9rem">
    This grants the client below full access to the Expensify account
    configured on this server.
  </p>
  <p class="meta">Client: ${escapeHtml(params.clientId)}<br>
     Redirect: ${escapeHtml(params.redirectUri)}</p>
  <form method="POST">
    <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(params.state)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
    <input type="hidden" name="resource" value="${escapeHtml(params.resource)}">
    <label for="pw">Owner password</label>
    <input id="pw" type="password" name="owner_password" autocomplete="current-password"
      autofocus required>
    <button type="submit">Approve</button>
  </form>
</div>
</body></html>`;
}

/**
 * OAuth 2.1 authorization endpoint.
 *
 * GET renders a consent screen; POST checks the owner password and redirects
 * with an authorization code. The password is what makes this single-owner:
 * dynamic registration is open, but no one without it can complete a flow.
 */
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  let env;
  try {
    env = loadOAuthEnv();
  } catch (error) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain');
    res.end(
      error instanceof OAuthConfigError
        ? error.message
        : 'Server configuration error',
    );
    return;
  }

  const url = new URL(req.url ?? '/', `https://${req.headers.host}`);
  const resource = canonicalResource(req);

  const fromQuery = (key: string): string =>
    url.searchParams.get(key) ?? '';

  if (req.method === 'GET') {
    const clientId = fromQuery('client_id');
    const redirectUri = fromQuery('redirect_uri');
    const codeChallenge = fromQuery('code_challenge');
    const method = fromQuery('code_challenge_method');

    if (!clientId || !redirectUri) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Missing client_id or redirect_uri');
      return;
    }
    // OAuth 2.1 requires PKCE, and only S256 is acceptable.
    if (!codeChallenge || method !== 'S256') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('PKCE required: code_challenge with code_challenge_method=S256');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      consentPage({
        clientId,
        redirectUri,
        state: fromQuery('state'),
        codeChallenge,
        scope: fromQuery('scope') || 'expensify',
        resource,
      }),
    );
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  const form = await readForm(req);
  const clientId = form.get('client_id') ?? '';
  const redirectUri = form.get('redirect_uri') ?? '';
  const state = form.get('state') ?? '';
  const codeChallenge = form.get('code_challenge') ?? '';
  const scope = form.get('scope') ?? 'expensify';
  const password = form.get('owner_password') ?? '';

  if (!constantTimeEquals(password, env.ownerPassword)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      consentPage({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        scope,
        resource,
        error: 'Incorrect password.',
      }),
    );
    return;
  }

  // Binding the code to the redirect URI that registered this client_id stops
  // a stolen code from being redeemed against a different callback.
  const expectedClientId = deriveClientId([redirectUri], env.signingSecret);
  if (!constantTimeEquals(clientId, expectedClientId)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('client_id does not match redirect_uri');
    return;
  }

  const code = issueToken(
    {
      sub: OWNER_SUBJECT,
      client_id: clientId,
      aud: resource,
      exp: Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS,
      typ: 'code',
      cc: codeChallenge,
      ru: redirectUri,
    },
    env.signingSecret,
  );

  const location = new URL(redirectUri);
  location.searchParams.set('code', code);
  if (state) location.searchParams.set('state', state);

  res.statusCode = 302;
  res.setHeader('Location', location.toString());
  res.end();
}
