import { describe, expect, test } from 'bun:test';
import { findEnvFiles, looksSecret, parseEnvKeys } from '../src/lib/env-example';

describe('findEnvFiles', () => {
  test('finds example files at any depth, shallowest first', () => {
    const paths = [
      'src/.env.example',
      'apps/api/.env.sample',
      '.env.example',
      '.env',
      'README.md',
      'docs/env.example.txt',
      'node_modules/left-pad/.env.example',
    ];

    expect(findEnvFiles(paths)).toEqual([
      '.env.example',
      'src/.env.example',
      'apps/api/.env.sample',
    ]);
  });

  test('accepts the template variants and ignores a real .env', () => {
    expect(findEnvFiles(['.env.template', '.env.dist', '.env.local'])).toEqual([
      '.env.dist',
      '.env.template',
    ]);
  });

  test('a repo with none returns nothing', () => {
    expect(findEnvFiles(['index.ts', 'Dockerfile', 'docs/env-vars.md'])).toEqual([]);
  });
});

describe('parseEnvKeys', () => {
  test('reads assignments, exports, quotes and comments', () => {
    const text = [
      '# Database',
      'DATABASE_URL=postgres://user:pass@db/app',
      'export NODE_ENV="production"',
      "PORT='3000'",
      '',
      'KEY_WITH_EMPTY=',
      '  SPACED  =  value  ',
    ].join('\n');

    expect(parseEnvKeys(text).map((entry) => entry.key)).toEqual([
      'DATABASE_URL',
      'NODE_ENV',
      'PORT',
      'KEY_WITH_EMPTY',
      'SPACED',
    ]);
  });

  test('skips commented-out names: an example that is disabled is not a requirement', () => {
    const text = ['#STRIPE_SECRET=sk_test_x', '# SMTP_PASSWORD=', 'LIVE_ONE=1'].join('\n');
    expect(parseEnvKeys(text).map((entry) => entry.key)).toEqual(['LIVE_ONE']);
  });

  test('dedupes, first occurrence wins, and keeps the trailing comment of the line above', () => {
    const text = ['# Where mail goes', 'MAIL_FROM=a@b.c', 'MAIL_FROM=other@b.c'].join('\n');
    const keys = parseEnvKeys(text);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key: 'MAIL_FROM', comment: 'Where mail goes' });
  });

  test('drops anything that is not a legal variable name', () => {
    const text = ['1BAD=x', 'A-B=x', 'OK_NAME=x', 'WITH SPACE=x'].join('\n');
    expect(parseEnvKeys(text).map((entry) => entry.key)).toEqual(['OK_NAME']);
  });

  test('a commented-out assignment is not documentation for the name below it', () => {
    expect(parseEnvKeys(['#STRIPE_SECRET=sk_test_x', 'STRIPE_SECRET='].join('\n'))).toEqual([
      { key: 'STRIPE_SECRET', comment: null },
    ]);
  });

  test('a bare word is not an assignment', () => {
    expect(parseEnvKeys(['JUST_A_WORD', 'REAL=1'].join('\n')).map((entry) => entry.key)).toEqual([
      'REAL',
    ]);
  });

  test('handles CRLF and never returns a value', () => {
    const parsed = parseEnvKeys('A=1\r\nB=2\r\n');
    expect(parsed).toEqual([
      { key: 'A', comment: null },
      { key: 'B', comment: null },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('=1');
  });

  test('keeps duplicate-free order as written', () => {
    expect(parseEnvKeys('Z=1\nA=2\nM=3').map((e) => e.key)).toEqual(['Z', 'A', 'M']);
  });
});

describe('looksSecret', () => {
  test('flags credential-shaped names', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'API_KEY',
      'APIKEY',
      'STRIPE_SECRET',
      'DB_PASSWORD',
      'SMTP_PASS',
      'MYSQL_PWD',
      'SESSION_SECRET',
      'AWS_SECRET_ACCESS_KEY',
      'PRIVATE_KEY',
      'DSN',
      'SALT',
      'CREDENTIALS',
      'AUTH_HEADER',
    ]) {
      expect(looksSecret(name)).toBe(true);
    }
  });

  test('leaves ordinary configuration alone', () => {
    for (const name of ['NODE_ENV', 'PORT', 'LOG_LEVEL', 'MONKEY', 'PUBLIC_URL', 'FEATURE_X']) {
      expect(looksSecret(name)).toBe(false);
    }
  });
});
