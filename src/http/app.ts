import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';

import { type Auth, BASE_PATH, CONSENT_PATH, ERROR_PATH, LOGIN_PATH } from '../auth/better-auth.js';
import type { Database } from '../db/client.js';
import { log } from '../log.js';
import { consentPage, errorPage } from './pages.js';

export interface AppOptions {
  db: Database;
  auth: Auth;
}

/** The query string exactly as received: the OAuth request is signed over it. */
const rawQuery = (req: Request): string => req.originalUrl.split('?')[1] ?? '';

/** Sends a Better Auth API response on: cookies as set, then the redirect target it names. */
async function forwardRedirect(res: Response, response: globalThis.Response): Promise<void> {
  for (const cookie of response.headers.getSetCookie()) res.append('Set-Cookie', cookie);
  const location = response.headers.get('location');
  if (location) {
    res.redirect(302, location);
    return;
  }
  const body = (await response.json().catch(() => ({}))) as { url?: unknown };
  if (response.ok && typeof body.url === 'string') {
    res.redirect(302, body.url);
    return;
  }
  res.status(400).type('html').send(errorPage('The request has expired. Please start again.'));
}

export function createApp({ db, auth }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy: use X-Forwarded-For from exactly one proxy hop.
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });

  // Liveness/readiness for Docker. Returns no data, so it stays unauthenticated.
  app.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok' });
    } catch {
      log.error('health check failed: database unreachable');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // RFC 8414 metadata at the root, since the issuer is the bare origin.
  const metadata = oauthProviderAuthServerMetadata(auth);
  app.get('/.well-known/oauth-authorization-server', async (req, res) => {
    const response = await metadata(new Request(new URL(req.originalUrl, 'http://local')));
    res
      .status(response.status)
      .type('json')
      .set('Cache-Control', 'public, max-age=300')
      .send(await response.text());
  });

  // Better Auth reads the raw body itself, so it is mounted before any body parser.
  app.all(`${BASE_PATH}/*splat`, toNodeHandler(auth));

  // Login: GitHub is the only option, so go there straight away. Better Auth carries the signed
  // authorization request through the GitHub round trip and resumes it afterwards.
  app.get(LOGIN_PATH, async (req, res) => {
    // `oauth_query` is read by the OAuth provider plugin's hook, not by the sign-in endpoint
    // itself, so it is not part of the endpoint's body type.
    const body = { provider: 'github', callbackURL: '/', oauth_query: rawQuery(req) };
    const response = await auth.api.signInSocial({
      body,
      headers: fromNodeHeaders(req.headers),
      asResponse: true,
    });
    await forwardRedirect(res, response);
  });

  app.get(CONSENT_PATH, async (req, res) => {
    const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : '';
    const headers = fromNodeHeaders(req.headers);
    const client = await auth.api
      .getOAuthClientPublic({ query: { client_id: clientId }, headers })
      .catch(() => null);
    if (!client) {
      res.status(400).type('html').send(errorPage('Unknown application or expired session.'));
      return;
    }
    const resource = typeof req.query.resource === 'string' ? req.query.resource : null;
    res.type('html').send(
      consentPage({
        clientName: client.client_name ?? clientId,
        resource,
        oauthQuery: rawQuery(req),
      }),
    );
  });

  app.post(
    CONSENT_PATH,
    express.urlencoded({ extended: false, limit: '16kb' }),
    async (req, res) => {
      const body = req.body as { accept?: unknown; oauth_query?: unknown };
      const response = await auth.api.oauth2Consent({
        body: {
          accept: body.accept === 'true',
          oauth_query: typeof body.oauth_query === 'string' ? body.oauth_query : '',
        },
        headers: fromNodeHeaders(req.headers),
        asResponse: true,
      });
      await forwardRedirect(res, response);
    },
  );

  app.get(ERROR_PATH, (req, res) => {
    const denied =
      req.query.error === 'access_denied' || req.query.error === 'unable_to_get_user_info';
    res
      .status(400)
      .type('html')
      .send(
        errorPage(
          denied
            ? 'This account is not allowed to sign in here.'
            : 'Something went wrong. Please start again from the application.',
        ),
      );
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    log.error('unhandled request error', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    if (!res.headersSent) res.status(500).type('html').send(errorPage('Internal error.'));
  };
  app.use(errorHandler);

  return app;
}
