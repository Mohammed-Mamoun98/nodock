import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

/**
 * AES-256-GCM with a key derived from NODOCK_SECRET. There is no key file: the
 * env var is the single source of truth, so losing it loses every `*_enc` value.
 */
export function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognised ciphertext format');
  }

  const [, ivPart, tagPart, dataPart] = parts;
  if (!ivPart || !tagPart || !dataPart) throw new Error('Malformed ciphertext');

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A wrong key and a tampered payload are the same event: authentication failed.
    throw new Error('Unable to decrypt: wrong key or tampered payload');
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
