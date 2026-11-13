import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAuth } from '../../src/auth/better-auth.js';
import type { GithubUser } from '../../src/auth/github.js';
import type { AppConfig } from '../../src/config.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { createApp } from '../../src/http/app.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

// All identities below are invented.
const OWNER: GithubUser = { id: 4242, login: 'muster-owner' };
const STRANGER: GithubUser = { id: 1111, login: 'someone-else' };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = 'https://mcp.example.test/mcp';
const OTHER_RESOURCE = 'https://other.example.test/mcp';

let testDb: TestDatabase;
let database: DatabaseHandle;
let server: Server;
let baseUrl: string;
/** The GitHub user the fake GitHub reports for the next login. */
let githubUser: GithubUser = OWNER;
/** Registered once, like claude.ai does per connector (registration is rate-limited). */
let clientId: string;
let clientSecret: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  database = createDatabase(testDb.appUrl);

  // The issuer must contain the port, which is only known after listening.
  const late: { app?: Express } = {};
  server = createServer((req, res) => {
    late.app?.(req, res);
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const config: AppConfig = {
    publicBaseUrl: baseUrl,
    port: 0,
    databaseUrl: testDb.appUrl,
    secret: 'not-a-secret'.padEnd(40, '-'),
    github: { clientId: 'test-github-client', clientSecret: 'test-github-secret' },
    allowedGithubUserIds: [OWNER.id],
    resources: [RESOURCE, OTHER_RESOURCE],
    allowedRedirectUris: [CALLBACK],
  };
  const auth = createAuth({
    db: database.db,
    config,
    lookupGithubUser: () => Promise.resolve(githubUser),
  });
  late.app = createApp({ db: database.db, auth });

  // Fake GitHub's token endpoint; everything else (our own server) goes through.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return Promise.resolve(
        Response.json({ access_token: 'gho_fake', token_type: 'bearer', scope: '' }),
      );
    }
    return realFetch(input, init);
  });
});

beforeAll(async () => {
  const res = await register();
  ({ client_id: clientId, client_secret: clientSecret } = (await res.json()) as {
    client_id: string;
    client_secret: string;
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
  await database.close();
  await testDb.container.stop();
});

/**
 * A browser navigating pages: keeps cookies, follows nothing automatically. Uses node:http
 * because Node's fetch always sends `Sec-Fetch-Mode: cors`, which marks a request as a script
 * call (Better Auth then answers redirects as JSON, as it should for fetch()).
 */
function browser() {
  const jar = new Map<string, string>();
  return (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<globalThis.Response>((resolve, reject) => {
      const req = request(
        new URL(url, baseUrl),
        {
          method: init.method ?? 'GET',
          headers: {
            Accept: 'text/html',
            'Sec-Fetch-Mode': 'navigate',
            ...init.headers,
            Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              for (const v of Array.isArray(value) ? value : [value ?? '']) headers.append(name, v);
            }
            for (const cookie of headers.getSetCookie()) {
              const [pair = ''] = cookie.split(';');
              const [name = '', ...value] = pair.split('=');
              jar.set(name.trim(), value.join('='));
            }
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
          });
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
}

const location = (res: globalThis.Response) => new URL(res.headers.get('location') ?? '', baseUrl);

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(redirectUris = [CALLBACK]) {
  return fetch(`${baseUrl}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      // Exactly what claude.ai sends: a confidential client without scopes.
      client_name: 'Claude',
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
}

async function token(params: Record<string, string>) {
  return fetch(`${baseUrl}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

/** authorize → /login → GitHub (faked) → callback; returns where the browser ends up. */
async function authorize(challenge: string, resource = RESOURCE) {
  const visit = browser();
  const authorizeUrl = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource,
  }).toString();

  const toLogin = await visit(authorizeUrl.toString());
  expect(toLogin.status).toBe(302);
  expect(location(toLogin).pathname, location(toLogin).search).toBe('/login');

  const toGithub = await visit(location(toLogin).toString());
  expect(toGithub.status).toBe(302);
  const githubUrl = location(toGithub);
  expect(githubUrl.origin).toBe('https://github.com');
  expect(githubUrl.searchParams.get('scope') ?? '').toBe('');

  const callback = await visit(
    `/api/auth/callback/github?code=fake-code&state=${githubUrl.searchParams.get('state') ?? ''}`,
  );
  return { visit, callback };
}

/** Full happy path including consent; returns the client's code. */
/** Full happy path; consents on the consent page when asked. Returns the client's code. */
async function loginAndConsent(challenge: string, resource = RESOURCE) {
  const { visit, callback } = await authorize(challenge, resource);
  expect(callback.status).toBe(302);
  let redirect = location(callback);
  if (redirect.pathname === '/consent') {
    const consent = await visit(redirect.toString());
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain('Claude');
    const oauthQuery = /name="oauth_query" value="([^"]*)"/
      .exec(html)?.[1]
      ?.replaceAll('&amp;', '&');

    const toClient = await visit('/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accept: 'true', oauth_query: oauthQuery ?? '' }).toString(),
    });
    expect(toClient.status).toBe(302);
    redirect = location(toClient);
  }
  expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK);
  expect(redirect.searchParams.get('state')).toBe('client-state');
  return redirect.searchParams.get('code') ?? '';
}

async function fullLogin(resource = RESOURCE) {
  const { verifier, challenge } = pkce();
  const code = await loginAndConsent(challenge, resource);
  const res = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: CALLBACK,
    resource,
  });
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { ...(body as { access_token: string; refresh_token: string }) };
}

describe('authorization server', () => {
  it('publishes metadata with the bare origin as issuer', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const metadata = (await res.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(baseUrl);
    expect(metadata.registration_endpoint).toBe(`${baseUrl}/api/auth/oauth2/register`);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
  });

  it('registers clients only with allowed redirect URIs', async () => {
    expect((await register(['https://attacker.example/cb'])).status).toBe(400);
    expect((await register([CALLBACK, 'https://attacker.example/cb'])).status).toBe(400);
  });

  it('asks for consent once per client, then remembers it', async () => {
    const first = await authorize(pkce().challenge);
    expect(location(first.callback).pathname).toBe('/consent');
    await loginAndConsent(pkce().challenge);
    const again = await authorize(pkce().challenge);
    expect(`${location(again.callback).origin}${location(again.callback).pathname}`).toBe(CALLBACK);
  });

  it('issues a JWT access token bound to the requested resource', async () => {
    const { access_token: accessToken, refresh_token: refreshToken } = await fullLogin();
    expect(refreshToken).toBeTruthy();

    const jwks = createRemoteJWKSet(new URL(`${baseUrl}/api/auth/jwks`));
    // Exactly the checks a resource server (hschaletzky-pipeline) applies.
    const { payload } = await jwtVerify(accessToken, jwks, {
      issuer: baseUrl,
      audience: RESOURCE,
      typ: 'at+jwt',
      requiredClaims: ['sub', 'exp'],
    });
    expect(payload.sub).toBeTruthy();
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
    await expect(
      jwtVerify(accessToken, jwks, { issuer: baseUrl, audience: OTHER_RESOURCE }),
    ).rejects.toThrow();
  });

  it('issues tokens for other configured resources, each bound to its own audience', async () => {
    const { access_token: accessToken } = await fullLogin(OTHER_RESOURCE);
    expect(decodeJwt(accessToken).aud).toBe(OTHER_RESOURCE);
  });

  it('rotates refresh tokens: each one works exactly once', async () => {
    const { refresh_token: refreshToken } = await fullLogin();
    const refresh = (value: string) =>
      token({
        grant_type: 'refresh_token',
        refresh_token: value,
        client_id: clientId,
        client_secret: clientSecret,
        resource: RESOURCE,
      });

    const first = await refresh(refreshToken);
    expect(first.status).toBe(200);
    const { access_token: accessToken } = (await first.json()) as { access_token: string };
    expect(decodeJwt(accessToken).aud).toBe(RESOURCE);
    expect((await refresh(refreshToken)).status).toBe(400);
  });

  it('accepts an authorization code once and only with the right PKCE verifier', async () => {
    const { verifier, challenge } = pkce();
    const code = await loginAndConsent(challenge);
    const exchange = (codeVerifier: string) =>
      token({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: CALLBACK,
        resource: RESOURCE,
      });

    expect((await exchange(pkce().verifier)).status).toBe(400);
    // A failed attempt may burn the code; either way a correct retry must not yield two tokens.
    const second = await exchange(verifier);
    expect([200, 400]).toContain(second.status);
    expect((await exchange(verifier)).status).toBe(400);
  });

  it('rejects resources that are not configured', async () => {
    const visit = browser();
    const authorizeUrl = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 'client-state',
      resource: 'https://unknown.example.test/mcp',
    }).toString();
    const res = await visit(authorizeUrl.toString());
    const target = location(res);
    expect(target.pathname === '/login').toBe(false);
  });

  it('denies GitHub users that are not on the allowlist', async () => {
    githubUser = STRANGER;
    try {
      const { callback } = await authorize(pkce().challenge);
      expect(callback.status).toBe(302);
      const target = location(callback);
      expect(target.pathname).toBe('/error');
      expect(target.searchParams.has('code')).toBe(false);
    } finally {
      githubUser = OWNER;
    }
  });

  it('stores only the GitHub login and a noreply address for the owner', async () => {
    await fullLogin();
    const { rows } = await database.db.execute<{ name: string; email: string }>(
      sql`select name, email from "user"`,
    );
    expect(rows).toEqual([
      { name: OWNER.login, email: `${String(OWNER.id)}+${OWNER.login}@users.noreply.github.com` },
    ]);
  });

  it('rate-limits client registration', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await register()).status);
    expect(statuses).toContain(429);
  });
});
