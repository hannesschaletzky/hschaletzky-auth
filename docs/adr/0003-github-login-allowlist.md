# ADR 0003: GitHub login with an allowlist of user ids

- Status: accepted
- Date: 2026-11-13

## Context

There is one human user. Passwords mean password storage and no second factor; passkeys need more
UI than the time budget allows.

## Decision

- GitHub is the only identity provider. No GitHub scopes are requested; the server reads the public
  profile once (`/user`) and keeps the numeric id and login. The GitHub token is not stored.
- Only numeric GitHub ids in `ALLOWED_GITHUB_USER_IDS` may sign in (ids are stable, login names
  can change). Others end on an error page without a session or account.
- Better Auth requires an e-mail per user; the GitHub noreply address is derived from id and login
  instead of reading the real address (data minimisation).
- Sign-up with e-mail and password and account linking are disabled.

## Consequences

- The owner's GitHub 2FA protects every connector.
- Adding a person means adding their id and redeploying; there is no self-service sign-up.
