import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';

import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { log } from '../log.js';
import { type GithubUserLookup, githubUserLookup, toUserInfo } from './github.js';

export const BASE_PATH = '/api/auth';
export const LOGIN_PATH = '/login';
export const CONSENT_PATH = '/consent';
export const ERROR_PATH = '/error';

/** Short-lived access tokens; claude.ai refreshes them in the background. */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AuthOptions {
  db: Database;
  config: AppConfig;
  /** Injectable for tests; production asks the GitHub API. */
  lookupGithubUser?: GithubUserLookup;
}

/**
 * OAuth 2.1 authorization server for MCP connectors and other apps of the owner.
 *
 * - Login: GitHub only, and only for allow-listed numeric GitHub user ids. No GitHub scopes are
 *   requested; only the public profile id and login are read.
 * - Clients: dynamic registration (as claude.ai does it) restricted to allow-listed redirect URIs,
 *   and Client ID Metadata Documents (MCP 2026-07-28).
 * - Tokens: JWT access tokens bound to one configured resource (`aud`), verifiable by resource
 *   servers against /api/auth/jwks; refresh tokens rotate and work exactly once.
 */
export function createAuth({ db, config, lookupGithubUser = githubUserLookup }: AuthOptions) {
  const allowedUsers = new Set(config.allowedGithubUserIds);

  return betterAuth({
    appName: 'hschaletzky auth',
    baseURL: config.publicBaseUrl,
    basePath: BASE_PATH,
    secret: config.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    // The JWT plugin's own session-token endpoint is not needed; tokens come from /oauth2/token.
    disabledPaths: ['/token'],
    emailAndPassword: { enabled: false },
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        disableDefaultScope: true,
        getUserInfo: async (token) => {
          if (!token.accessToken) return null;
          const user = await lookupGithubUser(token.accessToken);
          if (!user) return null;
          if (!allowedUsers.has(user.id)) {
            log.warn('login denied: github user not allowed');
            return null;
          }
          return toUserInfo(user);
        },
      },
    },
    account: { accountLinking: { enabled: false } },
    onAPIError: { errorURL: `${config.publicBaseUrl}${ERROR_PATH}` },
    advanced: {
      // Behind Caddy: the client address comes from X-Forwarded-For (rate limiting).
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    rateLimit: { enabled: true, window: 60, max: 60 },
    hooks: {
      // Open registration as claude.ai needs it, but only for known callback URLs: a registered
      // client still needs the owner's login, and codes can only ever land at those URLs.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/oauth2/register') return;
        const uris: unknown = (ctx.body as { redirect_uris?: unknown } | undefined)?.redirect_uris;
        const valid =
          Array.isArray(uris) &&
          uris.length > 0 &&
          uris.every((uri) => typeof uri === 'string' && config.allowedRedirectUris.includes(uri));
        if (!valid) {
          throw new APIError('BAD_REQUEST', {
            error: 'invalid_redirect_uri',
            error_description: 'redirect_uri not allowed for this server',
          });
        }
        return Promise.resolve();
      }),
    },
    plugins: [
      jwt({ jwt: { issuer: config.publicBaseUrl }, disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: LOGIN_PATH,
        consentPage: CONSENT_PATH,
        resources: config.resources,
        // Every client may request tokens for every configured resource; each token is still
        // bound to exactly one of them.
        clientRegistrationDefaultResources: config.resources,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ['offline_access'],
        clientRegistrationAllowedScopes: ['offline_access'],
        scopes: ['offline_access'],
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
        refreshTokenReuseInterval: 0,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
