# hschaletzky-auth

A small OAuth 2.1 authorization server for MCP connectors (claude.ai) and other services of a
single owner. Login is GitHub only, restricted to an allowlist of GitHub user ids.

## Problem

Every MCP connector that claude.ai talks to needs OAuth. Building an authorization server into each
service duplicates security-critical code, and the MCP TypeScript SDK v2 no longer ships one: an MCP
server is meant to be a pure resource server that trusts a separate authorization server.

## Solution

One authorization server for all services, built on [Better Auth](https://www.better-auth.com) and
its OAuth provider plugin rather than hand-written OAuth code. It issues short-lived JWT access
tokens, each bound to exactly one service (`aud`). Services verify them locally against the
published keys and never see a password or a GitHub token.

## How it fits together

```
 claude.ai ──(1) POST /mcp ──────────────────────────► service (e.g. hschaletzky-pipeline)
     │      ◄── 401 + where to get a token (RFC 9728) ──┘
     │
     ├──(2) register (DCR) / authorize ─────────► auth.hschaletzky.com  (this repo)
     │                                               │ (3) GitHub login, allowlisted ids only
     │                                               │ (4) consent, once per client
     │      ◄── code ─────────────────────────────── ┘
     ├──(5) code + PKCE ──► /api/auth/oauth2/token ─► JWT access token (aud = service)
     │                                                + refresh token (rotates, single use)
     └──(6) POST /mcp + Bearer JWT ─────────────────► service verifies signature, iss, aud, exp
                                                       against /api/auth/jwks (cached)
```

| Endpoint                                  | Purpose                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `/.well-known/oauth-authorization-server` | Metadata (RFC 8414); the issuer is the bare origin     |
| `/api/auth/oauth2/register`               | Dynamic client registration, allowlisted redirect URIs |
| `/api/auth/oauth2/authorize`, `…/token`   | Authorization code flow with PKCE, refresh tokens      |
| `/api/auth/jwks`                          | Public signing keys for resource servers               |
| `/login`, `/consent`                      | Server-rendered pages, no JavaScript                   |
| `/health`                                 | Liveness, no data                                      |

Client ID Metadata Documents (MCP 2026-07-28) are supported as well.

```
src/
  auth/     Better Auth configuration, GitHub identity lookup
  http/     Express app: metadata, login/consent/error pages, Better Auth handler
  db/       generated Drizzle schema, client, migration runner
  config.ts environment validation
drizzle/    versioned SQL migrations (generated, committed)
docs/adr/   architecture decision records
```

Stack: TypeScript (strict), Node.js, Express 5, Better Auth, PostgreSQL 18, Drizzle ORM, Vitest,
Testcontainers.

## Quickstart (local)

Requirements: Node.js 26 (see `.nvmrc`), Docker, [gitleaks](https://github.com/gitleaks/gitleaks).

```sh
npm install
cp .env.example .env     # fill in a GitHub OAuth App and your numeric GitHub id
npm run db:up            # Postgres on 127.0.0.1:5433
npm run db:migrate
npm run dev              # http://localhost:4000/.well-known/oauth-authorization-server
```

Checks: `npm run lint`, `npm run typecheck`, `npm test` (unit and integration; the integration
tests run the complete flow against a real Postgres with a faked GitHub).

## Adding a service

1. Add its resource URL (e.g. `https://new.example.com/mcp`) to `RESOURCES` and deploy.
2. In the service, serve protected resource metadata naming this issuer, and verify tokens with
   `jose`: `jwtVerify(token, createRemoteJWKSet(jwksUrl), { issuer, audience: resourceUrl,
typ: 'at+jwt' })`. See `src/auth/index.ts` in
   [hschaletzky-pipeline](https://github.com/hannesschaletzky/hschaletzky-pipeline).

## Security and privacy

- Only allowlisted numeric GitHub ids can sign in; everyone else gets an error page and no session.
- No GitHub scopes are requested. Stored per user: the GitHub login and a GitHub noreply address,
  nothing else.
- Dynamic client registration is open (claude.ai needs it) but limited to allowlisted redirect URIs
  and rate-limited; a registered client still needs the owner's login and consent.
- Access tokens live one hour, refresh tokens 30 days and are single-use (rotation without a reuse
  window). Tokens are stored hashed.
- The database only holds disposable state (sessions, clients, tokens, signing keys). It is not
  backed up on purpose: if lost, sign in again and reconnect the connectors.
- Logs contain no tokens, names or e-mail addresses.

Decisions: [docs/adr](docs/adr).

## Deployment

After CI passes on `main`, `.github/workflows/deploy.yml` builds the image, pushes it to
`ghcr.io/hannesschaletzky/hschaletzky-auth` and triggers the deploy on the server, which runs the
migrations first. The server setup lives in
[hschaletzky-infra](https://github.com/hannesschaletzky/hschaletzky-infra).

## License

[MIT](LICENSE)
