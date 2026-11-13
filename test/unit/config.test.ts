import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_REDIRECT_URIS, loadAppConfig, resolveFileSecrets } from '../../src/config.js';

function secretFile(content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'auth-config-')), 'secret');
  writeFileSync(file, content);
  return file;
}

const valid = {
  PUBLIC_BASE_URL: 'https://auth.example.test/',
  DATABASE_URL: 'postgres://auth_app@localhost:5432/auth',
  DATABASE_PASSWORD: 'db-password',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  ALLOWED_GITHUB_USER_IDS: '4242, 1111',
  RESOURCES: 'https://mcp.example.test/mcp,https://other.example.test/mcp',
};

describe('loadAppConfig', () => {
  it('parses lists, uses the bare origin as issuer and defaults the redirect URIs', () => {
    const config = loadAppConfig(valid);
    expect(config.publicBaseUrl).toBe('https://auth.example.test');
    expect(config.databaseUrl).toBe('postgres://auth_app:db-password@localhost:5432/auth');
    expect(config.allowedGithubUserIds).toEqual([4242, 1111]);
    expect(config.resources).toEqual([
      'https://mcp.example.test/mcp',
      'https://other.example.test/mcp',
    ]);
    expect(config.allowedRedirectUris).toEqual(DEFAULT_REDIRECT_URIS);
  });

  it('rejects non-numeric GitHub ids, a short secret and an empty resource list', () => {
    expect(() => loadAppConfig({ ...valid, ALLOWED_GITHUB_USER_IDS: 'octocat' })).toThrow(
      /ALLOWED_GITHUB_USER_IDS/,
    );
    expect(() => loadAppConfig({ ...valid, BETTER_AUTH_SECRET: 'short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => loadAppConfig({ ...valid, RESOURCES: ' , ' })).toThrow(/RESOURCES/);
  });

  it('never reports secret values in errors', () => {
    const secret = 'super-secret-value';
    let message = '';
    try {
      loadAppConfig({ ...valid, BETTER_AUTH_SECRET: secret, PUBLIC_BASE_URL: 'not a url' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/PUBLIC_BASE_URL/);
    expect(message).not.toContain(secret);
  });
});

describe('resolveFileSecrets', () => {
  it('reads X_FILE into X and strips one trailing newline', () => {
    expect(resolveFileSecrets({ TOKEN_FILE: secretFile('abc\n') }, ['TOKEN']).TOKEN).toBe('abc');
  });

  it('refuses ambiguous configuration', () => {
    expect(() =>
      resolveFileSecrets({ TOKEN: 'a', TOKEN_FILE: secretFile('b') }, ['TOKEN']),
    ).toThrow(/either TOKEN or TOKEN_FILE/);
  });
});
