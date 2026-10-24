import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Stateless OAuth `state`: a nonce plus issue time, HMAC-signed with the server
 * secret. No cookie store to keep in sync, and it cannot be replayed past 10 min.
 */
export function createState(secret: string, now: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ n: randomBytes(16).toString('base64url'), t: now }),
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyState(secret: string, state: string, now: number = Date.now()): boolean {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return false;

  const expected = Buffer.from(sign(secret, payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      t?: unknown;
    };
    if (typeof parsed.t !== 'number') return false;
    return now - parsed.t <= STATE_MAX_AGE_MS && now - parsed.t >= 0;
  } catch {
    return false;
  }
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
