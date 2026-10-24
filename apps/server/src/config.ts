import { join } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODOCK_SECRET: z
    .string()
    .min(32, 'NODOCK_SECRET must be at least 32 characters (openssl rand -hex 32)'),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  /** Comma-separated GitHub logins allowed to sign in. */
  ADMIN_GITHUB_LOGIN: z.string().default(''),
  NODOCK_URL: z.string().url().default('http://localhost:3000'),
  BASE_DOMAIN: z.string().min(1).default('apps.localhost'),
  /** Container sets /data; a host run defaults to ./.data in the repo. */
  DATA_DIR: z.string().min(1).default('./.data'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Caddy access logs are off by default: they cost CPU and disk on a small box. */
  NODOCK_ACCESS_LOG: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  DOCKER_NETWORK: z.string().min(1).default('nodock'),
  /** Extra origins allowed to mutate (the Vite dev server, mainly). Same-origin is always allowed. */
  ALLOWED_ORIGINS: z.string().default(''),
  GHCR_USER: z.string().min(1).optional(),
  GHCR_TOKEN: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  secret: string;
  adminLogins: string[];
  github: { clientId?: string; clientSecret?: string };
  url: string;
  baseDomain: string;
  port: number;
  accessLog: boolean;
  dockerNetwork: string;
  /** Normalised extra origins permitted to send mutating requests. */
  allowedOrigins: string[];
  ghcr: { user?: string; token?: string };
  paths: {
    dataDir: string;
    dbFile: string;
    logsDir: string;
    envDir: string;
    backupsDir: string;
    webDir: string;
  };
}

/** Throws with every offending variable listed, rather than failing one at a time. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // A `.env` copied from `.env.example` carries empty values (`GITHUB_CLIENT_ID=`).
  // Treat those as absent so optional settings stay optional.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const e = parsed.data;
  const dataDir = e.DATA_DIR;

  return {
    secret: e.NODOCK_SECRET,
    adminLogins: e.ADMIN_GITHUB_LOGIN.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET },
    url: e.NODOCK_URL.replace(/\/$/, ''),
    baseDomain: e.BASE_DOMAIN.toLowerCase(),
    port: e.PORT,
    accessLog: e.NODOCK_ACCESS_LOG,
    dockerNetwork: e.DOCKER_NETWORK,
    allowedOrigins: e.ALLOWED_ORIGINS.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${value}`);
        }
      }),
    ghcr: { user: e.GHCR_USER, token: e.GHCR_TOKEN },
    paths: {
      dataDir,
      dbFile: join(dataDir, 'nodock.db'),
      logsDir: join(dataDir, 'logs'),
      envDir: join(dataDir, 'env'),
      backupsDir: join(dataDir, 'backups'),
      // Built SPA, baked into the image; absent during pure-API dev.
      webDir: join(import.meta.dir, '../../web/dist'),
    },
  };
}
