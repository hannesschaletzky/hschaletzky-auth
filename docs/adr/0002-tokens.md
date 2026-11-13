# ADR 0002: JWT access tokens bound to one resource

- Status: accepted
- Date: 2026-11-13

## Context

Resource servers (MCP services) must check every request. Calling the authorization server per
request (introspection) couples their availability to it; opaque tokens need that call.

## Decision

- Access tokens are JWTs (RFC 9068, `typ: at+jwt`), signed with keys published at
  `/api/auth/jwks`. Resource servers verify signature, `iss`, `aud`, `exp` locally and cache the
  keys.
- Every token names exactly one resource in `aud` (RFC 8707). A token for one service is useless
  at another.
- The issuer is the bare origin (`https://auth.hschaletzky.com`), so metadata sits at the root
  well-known path and `iss` is stable even if the API base path changes.
- Access tokens live one hour. Refresh tokens live 30 days and rotate without a reuse window: a
  stolen refresh token works at most once, and using it invalidates the owner's copy (detectable).
- claude.ai registers as a confidential client (`client_secret_post`) and requests no scopes; the
  server grants `offline_access` by default so a refresh token is always issued.

## Consequences

- Revocation is not instant: a stolen access token stays valid until it expires (≤ 1 h). Accepted
  for a single-owner setup; revoking the refresh token stops renewal.
- Key rotation works without coordination: resource servers refetch the JWKS when a token names an
  unknown key id.
