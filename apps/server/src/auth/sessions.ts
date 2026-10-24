import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';

export const SESSION_COOKIE = 'nodock_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  login: string;
  avatarUrl: string | null;
  tokenEnc: string | null;
  scopes: string[];
}

/** Only the hash is stored, so a database leak does not hand out live sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSession(
  db: Db,
  userId: string,
  now: number = Date.now(),
): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + SESSION_TTL_MS);
  db.insert(sessions)
    .values({ userId, tokenHash: hashToken(token), expiresAt })
    .run();
  return { token, expiresAt };
}

export function findSessionUser(
  db: Db,
  token: string,
  now: number = Date.now(),
): SessionUser | null {
  const row = db
    .select({
      userId: users.id,
      login: users.login,
      avatarUrl: users.avatarUrl,
      tokenEnc: users.tokenEnc,
      scopes: users.scopes,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date(now))))
    .get();

  if (!row) return null;

  return {
    id: row.userId,
    login: row.login,
    avatarUrl: row.avatarUrl,
    tokenEnc: row.tokenEnc,
    scopes: row.scopes ? row.scopes.split(' ').filter(Boolean) : [],
  };
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .run();
}

/** Housekeeping: expired rows are dead weight, not audit history. */
export function deleteExpiredSessions(db: Db, now: number = Date.now()): number {
  const expired = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.expiresAt, new Date(now)))
    .all();

  if (expired.length === 0) return 0;
  db.delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now)))
    .run();
  return expired.length;
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict';
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAgeSeconds !== undefined)
    parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
