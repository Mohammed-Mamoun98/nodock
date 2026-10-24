import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';

/**
 * GitHub stores Actions secrets as **libsodium sealed boxes**
 * (`crypto_box_seal`): only the repo's public key can encrypt, only GitHub can
 * open it. tweetnacl does not implement sealed boxes, and a WASM libsodium is a
 * heavy dependency for one call, so the construction is assembled from audited
 * primitives:
 *
 *   sealed = eph_pub || XSalsa20-Poly1305( X25519(eph_sk, recipient_pk), msg )
 *   nonce  = BLAKE2b-24(eph_pub || recipient_pk)
 *
 * which is exactly what libsodium does.
 */
export function sealSecret(value: string, publicKeyBase64: string): string {
  const recipient = Buffer.from(publicKeyBase64, 'base64');
  if (recipient.length !== 32) throw new Error('GitHub returned a malformed public key');

  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);

  const nonce = blake2b(Buffer.concat([ephemeralPublic, recipient]), { dkLen: 24 });
  const shared = x25519.getSharedSecret(ephemeralSecret, recipient);

  const ciphertext = xsalsa20poly1305(shared, nonce).encrypt(new TextEncoder().encode(value));

  return Buffer.concat([ephemeralPublic, ciphertext]).toString('base64');
}

/** Only used by tests: opens a sealed box given the recipient's private key. */
export function openSealed(sealedBase64: string, recipientSecret: Uint8Array): string {
  const sealed = Buffer.from(sealedBase64, 'base64');
  const ephemeralPublic = sealed.subarray(0, 32);
  const ciphertext = sealed.subarray(32);

  const nonce = blake2b(Buffer.concat([ephemeralPublic, x25519.getPublicKey(recipientSecret)]), {
    dkLen: 24,
  });
  const shared = x25519.getSharedSecret(recipientSecret, ephemeralPublic);

  return new TextDecoder().decode(xsalsa20poly1305(shared, nonce).decrypt(ciphertext));
}
