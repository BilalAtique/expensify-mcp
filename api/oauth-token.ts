import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  OWNER_SUBJECT,
  OAuthConfigError,
  canonicalResource,
  loadOAuthEnv,
} from '../src/lib/oauth-config.js';
import {
  constantTimeEquals,
  issueToken,
  verifyPkce,
  verifyToken,
} from '../src/lib/oauth-store.js';

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

function fail(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error, error_description: description }));
}

/** Exchanges an authorization code (or refresh token) for an access token. */
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    fail(res, 405, 'invalid_request', 'POST required');
    return;
  }

  let env;
  try {
    env = loadOAuthEnv();
  } catch (error) {
    fail(
      res,
      503,
      'server_error',
      error instanceof OAuthConfigError ? error.message : 'config error',
    );
    return;
  }

  const form = await readForm(req);
  const grantType = form.get('grant_type') ?? '';
  const resource = canonicalResource(req);
  const now = Math.floor(Date.now() / 1000);

  const mint = (): void => {
    const accessToken = issueToken(
      {
        sub: OWNER_SUBJECT,
        client_id: form.get('client_id') ?? '',
        aud: resource,
        exp: now + ACCESS_TOKEN_TTL_SECONDS,
        typ: 'access',
      },
      env.signingSecret,
    );
    const refreshToken = issueToken(
      {
        sub: OWNER_SUBJECT,
        client_id: form.get('client_id') ?? '',
        aud: resource,
        exp: now + ACCESS_TOKEN_TTL_SECONDS * 6,
        typ: 'refresh',
      },
      env.signingSecret,
    );

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: 'expensify',
      }),
    );
  };

  if (grantType === 'authorization_code') {
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';

    const result = verifyToken(code, env.signingSecret, {
      typ: 'code',
      aud: resource,
    });
    if (!result.valid) {
      fail(res, 400, 'invalid_grant', result.reason);
      return;
    }

    if (!verifier || !result.claims.cc || !verifyPkce(verifier, result.claims.cc)) {
      fail(res, 400, 'invalid_grant', 'PKCE verification failed');
      return;
    }

    // The code was bound to one redirect URI at issue time.
    if (result.claims.ru && !constantTimeEquals(redirectUri, result.claims.ru)) {
      fail(res, 400, 'invalid_grant', 'redirect_uri mismatch');
      return;
    }

    mint();
    return;
  }

  if (grantType === 'refresh_token') {
    const token = form.get('refresh_token') ?? '';
    const result = verifyToken(token, env.signingSecret, {
      typ: 'refresh',
      aud: resource,
    });
    if (!result.valid) {
      fail(res, 400, 'invalid_grant', result.reason);
      return;
    }
    mint();
    return;
  }

  fail(res, 400, 'unsupported_grant_type', `Unsupported: ${grantType}`);
}
