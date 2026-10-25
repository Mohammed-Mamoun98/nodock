import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { decrypt } from './crypto';
import { findSessionUser, parseCookies, SESSION_COOKIE } from './sessions';

/**
 * The signed-in user's GitHub token, decrypted for one request.
 *
 * The token is stored encrypted and never cached as plaintext: a route that needs to
 * call GitHub borrows it, uses it, and forgets it.
 */
export function readSessionToken(
  db: Db,
  key: Buffer,
  cookieHeader: string | undefined,
  now: number = Date.now(),
): { token: string; userId: string } | null {
  const sessionToken = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!sessionToken) return null;

  const user = findSessionUser(db, sessionToken, now);
  if (!user) return null;

  const row = db
    .select({ tokenEnc: users.tokenEnc })
    .from(users)
    .where(eq(users.id, user.id))
    .get();
  if (!row?.tokenEnc) return null;

  try {
    return { token: decrypt(row.tokenEnc, key), userId: user.id };
  } catch {
    return null;
  }
}
