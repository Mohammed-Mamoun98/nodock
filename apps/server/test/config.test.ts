import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

const base = {
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com/',
  BASE_DOMAIN: 'Apps.Example.com',
};

describe('loadConfig', () => {
  test('derives paths and normalises values', () => {
    const config = loadConfig({ ...base, DATA_DIR: '/srv/nodock', ADMIN_GITHUB_LOGIN: 'Alice, bob' });

    expect(config.url).toBe('https://panel.example.com'); // trailing slash stripped
    expect(config.baseDomain).toBe('apps.example.com');
    expect(config.adminLogins).toEqual(['alice', 'bob']);
    expect(config.paths.dbFile).toBe('/srv/nodock/nodock.db');
    expect(config.paths.logsDir).toBe('/srv/nodock/logs');
    expect(config.paths.backupsDir).toBe('/srv/nodock/backups');
    expect(config.accessLog).toBe(false);
    expect(config.port).toBe(3000);
  });

  test('access logs are opt-in only', () => {
    expect(loadConfig({ ...base, NODOCK_ACCESS_LOG: '1' }).accessLog).toBe(true);
    expect(loadConfig({ ...base, NODOCK_ACCESS_LOG: '0' }).accessLog).toBe(false);
  });

  test('treats blank optional values from a copied .env as absent', () => {
    const config = loadConfig({
      ...base,
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      GHCR_TOKEN: '',
      ADMIN_GITHUB_LOGIN: '',
    });

    expect(config.github.clientId).toBeUndefined();
    expect(config.github.clientSecret).toBeUndefined();
    expect(config.ghcr.token).toBeUndefined();
    expect(config.adminLogins).toEqual([]);
  });

  test('rejects a short secret', () => {
    expect(() => loadConfig({ ...base, NODOCK_SECRET: 'tooshort' })).toThrow(/NODOCK_SECRET/);
  });

  test('reports every offending variable at once', () => {
    let message = '';
    try {
      loadConfig({ NODOCK_SECRET: 'short', NODOCK_URL: 'not-a-url' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('NODOCK_SECRET');
    expect(message).toContain('NODOCK_URL');
  });
});
