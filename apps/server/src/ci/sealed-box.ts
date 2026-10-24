import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';

/**
 * GitHub stores Actions secrets as **libsodium sealed boxes** (`crypto_box_seal`).
 * tweetnacl does not implement them, and a WASM libsodium is a heavy dependency for
 * one call, so the construction is assembled from audited primitives:
 *
 *   esk/epk      = ephemeral X25519 keypair
 *   shared       = X25519(esk, recipient_pk)
 *   subkey       = HSalsa20(shared, zeros)      ← crypto_box_beforenm
 *   nonce        = BLAKE2b-24(epk || recipient_pk)
 *   sealed       = epk || XSalsa20-Poly1305(subkey, nonce, message)
 *
 * The HSalsa20 step is the one that is easy to miss: without it the ciphertext looks
 * valid but libsodium cannot open it, and GitHub answers 422. Interop is pinned by a
 * test vector produced by PyNaCl (real libsodium).
 */

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function wordsLE(bytes: Uint8Array): Uint32Array {
  const out = new Uint32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = view.getUint32(index * 4, true);
  }
  return out;
}

/** crypto_box_beforenm: the XSalsa20 key is HSalsa20(shared, 0). */
export function boxSubkey(shared: Uint8Array): Uint8Array {
  const out = new Uint32Array(8);
  hsalsa(SIGMA, wordsLE(shared), new Uint32Array(4), out);
  return new Uint8Array(out.buffer.slice(0));
}

function nonceFor(ephemeralPublic: Uint8Array, recipient: Uint8Array): Uint8Array {
  return blake2b(Buffer.concat([ephemeralPublic, recipient]), { dkLen: 24 });
}

export function sealSecret(value: string, publicKeyBase64: string): string {
  const recipient = Buffer.from(publicKeyBase64, 'base64');
  if (recipient.length !== 32) throw new Error('GitHub returned a malformed public key');

  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, recipient);

  const ciphertext = xsalsa20poly1305(
    boxSubkey(shared),
    nonceFor(ephemeralPublic, recipient),
  ).encrypt(new TextEncoder().encode(value));

  return Buffer.concat([ephemeralPublic, ciphertext]).toString('base64');
}

/** Used by tests: opens a sealed box with the recipient's private key. */
export function openSealed(sealedBase64: string, recipientSecret: Uint8Array): string {
  const sealed = Buffer.from(sealedBase64, 'base64');
  const ephemeralPublic = sealed.subarray(0, 32);
  const ciphertext = sealed.subarray(32);

  const shared = x25519.getSharedSecret(recipientSecret, ephemeralPublic);
  const nonce = nonceFor(ephemeralPublic, x25519.getPublicKey(recipientSecret));

  return new TextDecoder().decode(xsalsa20poly1305(boxSubkey(shared), nonce).decrypt(ciphertext));
}
