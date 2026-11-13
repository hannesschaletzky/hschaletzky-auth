import type { GithubProfile } from 'better-auth/social-providers';

/**
 * GitHub as the only identity provider. We only need to know *who* logged in: no scopes are
 * requested, so the GitHub token can read the public profile and nothing else, and it is used
 * for exactly one lookup.
 */
export interface GithubUser {
  /** Numeric id: stable, unlike the login name. */
  id: number;
  login: string;
}

export type GithubUserLookup = (accessToken: string) => Promise<GithubUser | null>;

export const githubUserLookup: GithubUserLookup = async (accessToken) => {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'hschaletzky-auth',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const profile = (await res.json()) as { id?: unknown; login?: unknown };
  if (typeof profile.id !== 'number' || typeof profile.login !== 'string') return null;
  return { id: profile.id, login: profile.login };
};

/**
 * Better Auth needs an e-mail address per user. Data minimisation: we store GitHub's noreply
 * address instead of reading the real one (which would need the `user:email` scope).
 */
export function toUserInfo(user: GithubUser) {
  return {
    user: {
      name: user.login,
      email: `${String(user.id)}+${user.login}@users.noreply.github.com`,
      emailVerified: true,
    },
    // Better Auth keys the account by `data.id`; nothing else from the profile is kept.
    data: { id: String(user.id), login: user.login } as GithubProfile,
  };
}
