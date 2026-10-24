import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db/client';

const config = loadConfig();

for (const dir of [
  config.paths.dataDir,
  config.paths.logsDir,
  config.paths.envDir,
  config.paths.backupsDir,
]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const { db } = openDatabase(config.paths.dbFile);

const migrationsFolder = join(import.meta.dir, '../drizzle');
if (existsSync(migrationsFolder)) {
  migrate(db, { migrationsFolder });
}

const app = createApp({ config, db });

const indexHtml = join(config.paths.webDir, 'index.html');

function serveSpa(pathname: string): Response | null {
  if (!existsSync(indexHtml)) return null;
  // Hashed assets are immutable; index.html must never be cached.
  const candidate = join(config.paths.webDir, pathname);
  if (
    candidate.startsWith(config.paths.webDir) &&
    existsSync(candidate) &&
    !pathname.endsWith('/')
  ) {
    return new Response(Bun.file(candidate));
  }
  return new Response(Bun.file(indexHtml), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const server = Bun.serve({
  port: config.port,
  fetch(req) {
    const url = new URL(req.url);
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/webhooks/') ||
      url.pathname.startsWith('/internal/') ||
      url.pathname === '/healthz' ||
      url.pathname === '/metrics-lite'
    ) {
      return app.fetch(req);
    }
    const spa = serveSpa(url.pathname);
    if (spa) return spa;
    return app.fetch(req);
  },
});

console.log(`[nodock] listening on :${server.port} (base domain ${config.baseDomain})`);

// Boot diagnostics: most "it ignores my .env" reports are this, so say it out loud.
const githubReady = Boolean(config.github.clientId && config.github.clientSecret);
console.log(
  `[nodock] github oauth: ${githubReady ? 'configured' : 'NOT configured — set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET'}`,
);
console.log(
  `[nodock] admin allowlist: ${
    config.adminLogins.length > 0
      ? config.adminLogins.join(', ')
      : 'EMPTY — nobody can sign in (set ADMIN_GITHUB_LOGIN)'
  }`,
);
console.log(
  `[nodock] ghcr pull: ${config.ghcr.token ? 'token set' : 'anonymous (public packages only)'}`,
);
