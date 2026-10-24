import { describe, expect, test } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { openSealed, sealSecret } from '../src/ci/sealed-box';

/**
 * Produced by PyNaCl (i.e. real libsodium) with the private key below. If our
 * construction drifts, GitHub starts answering 422 on the Actions secrets API and
 * nothing else in the test suite notices — this vector is the guard.
 */
const LIBSODIUM_VECTOR = {
  publicKey: 'Ee3Oz9w9F+l7/B3UxVP+I3Ulkrw4I5dna7dsGpKNjQI=',
  secretKey: 'CCHIcLRV+lPD3dA3p5jcdQKr54PuZqB9ozhRafTjZVs=',
  sealed: 'VlPBbVNGlMh28IBpGVriNJ7ILfz5IMWrGvh/hPWDIRWVQxi2QzuTMegTrf1GMjiNDGvLXYR3Ju8PHtjT22Q=',
  plaintext: 'ghs_test_token',
};

describe('sealed box', () => {
  test('opens a ciphertext produced by libsodium', () => {
    const secret = Buffer.from(LIBSODIUM_VECTOR.secretKey, 'base64');
    expect(openSealed(LIBSODIUM_VECTOR.sealed, secret)).toBe(LIBSODIUM_VECTOR.plaintext);
  });

  test('round-trips through our own seal/open', () => {
    const secret = x25519.utils.randomSecretKey();
    const publicKey = Buffer.from(x25519.getPublicKey(secret)).toString('base64');

    const sealed = sealSecret('ghs_super_secret_value', publicKey);

    expect(openSealed(sealed, secret)).toBe('ghs_super_secret_value');
    expect(sealed).not.toContain('super_secret');
  });

  test('is 32 + plaintext + 16 bytes, and randomised per call', () => {
    const secret = x25519.utils.randomSecretKey();
    const publicKey = Buffer.from(x25519.getPublicKey(secret)).toString('base64');

    const first = Buffer.from(sealSecret('abc', publicKey), 'base64');
    const second = Buffer.from(sealSecret('abc', publicKey), 'base64');

    expect(first.length).toBe(32 + 3 + 16);
    expect(first.equals(second)).toBe(false);
  });

  test('rejects a malformed public key', () => {
    const short = Buffer.alloc(31).toString('base64');
    expect(() => sealSecret('x', short)).toThrow(/malformed public key/);
  });
});
