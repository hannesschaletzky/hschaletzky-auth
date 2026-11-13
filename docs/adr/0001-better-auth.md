# ADR 0001: Better Auth as the authorization server

- Status: accepted
- Date: 2026-11-13

## Context

claude.ai connectors require OAuth 2.1 with PKCE and dynamic client registration; MCP 2026-07-28
adds Client ID Metadata Documents. The owner expects more connectors and apps that need the same
login. The MCP TypeScript SDK v2 dropped its built-in authorization server and recommends a
dedicated one. Writing OAuth endpoints by hand is explicitly not wanted.

## Options

| Option                              | For                                                                                                    | Against                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Better Auth + OAuth provider plugin | TypeScript like the other services; DCR, CIMD, PKCE, JWT/JWKS, refresh rotation, GitHub login, Drizzle | A framework with its own tables and conventions              |
| Ory Hydra                           | Lean, certified                                                                                        | Separate login/consent app needed; two components to run     |
| Keycloak / Zitadel                  | Complete IdP products with admin UI                                                                    | Heavy for a 4 GB server; MCP specifics only partly supported |
| `oidc-provider`                     | Certified, flexible                                                                                    | Storage adapter and login interaction would be our own code  |
| Hosted (WorkOS, Auth0, Stytch)      | Least code                                                                                             | External dependency; login data with a third party           |

## Decision

Better Auth with `@better-auth/oauth-provider` and `@better-auth/cimd`, run as its own service.
The `mcp()` convenience plugin is not used because it binds the server to a single resource;
`oauthProvider()` with a list of `resources` serves several services from one issuer.

## Consequences

- Our code is configuration, two server-rendered pages and the GitHub allowlist. OAuth protocol
  handling (PKCE, token endpoint, client authentication, metadata) is Better Auth's.
- The database schema is generated from the Better Auth configuration
  (`npx auth generate`, see `scripts/`) and versioned as Drizzle migrations. After upgrading Better
  Auth, regenerate and review the migration.
