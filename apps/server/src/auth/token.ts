import { eq } from 'drizzle-orm';
import { parseCookies, SESSION_COOKIE, findSessionUser } from './sessions';
import { decrypt, deriveKey } from './crypto';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { users } from '../db/schema';

export interface SessionToken {
  token: string;
  userId: string;
}

/**
 * Resolves the stored GitHub token for the current session, decrypting per
 * request. Plaintext tokens are never cached in memory or in the DB.
 */
export function sessionToken(
  db: Db,
  config: Config,
  cookieHeader: string | undefined,
  now: number = Date.now(),
): SessionToken | null {
  const sessionCookie = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!sessionCookie) return null;

  const user = findSessionUser(db, sessionCookie, now);
  if (!user) return null;

  const row = db
    .select({ tokenEnc: users.tokenEnc })
    .from(users)
    .where(eq(users.id, user.id))
    .get();
  if (!row?.tokenEnc) return null;

  try {
    return { token: decrypt(row.tokenEnc, deriveKey(config.secret)), userId: user.id };
  } catch {
    return null;
  }
}
