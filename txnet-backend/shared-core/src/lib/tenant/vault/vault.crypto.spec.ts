import {
  FINGERPRINT_HEX_CHARS,
  IV_BYTES,
  KEY_BYTES,
  VaultDecryptionError,
  fingerprint,
  fingerprintsMatch,
  generateKey,
  open,
  parseKey,
  seal,
} from './vault.crypto';

/**
 * The vault's one spec (`docs/CODE-LAYOUT.md`'s budget), spent here rather
 * than on `CredentialVaultService`, because this is the file whose mistakes do
 * not throw. A rotation that writes the wrong version fails loudly the first
 * time anyone looks; a reused IV, a dropped auth tag, or a fingerprint that
 * leaks its input all keep working exactly as if they were right.
 */
describe('vault.crypto', () => {
  const key = generateKey();

  describe('seal / open', () => {
    it('round-trips a value', () => {
      const sealed = seal('bot-token-12345', key);
      expect(open(sealed, key, 'a test value')).toBe('bot-token-12345');
    });

    it('round-trips a value with multi-byte characters', () => {
      // A panel password may be anything. utf8 in, utf8 out, or the credential
      // comes back subtly wrong and only the third-party API notices.
      const secret = 'رمز عبور پنل — 🔐';
      expect(open(seal(secret, key), key, 'a test value')).toBe(secret);
    });

    it('never reuses an IV', () => {
      // GCM's one catastrophic misuse: the same key and IV twice leaks the
      // XOR of both plaintexts and, worse, the authentication subkey.
      const ivs = new Set(
        Array.from({ length: 200 }, () => seal('same value', key).iv),
      );
      expect(ivs.size).toBe(200);
      expect(Buffer.from([...ivs][0], 'base64')).toHaveLength(IV_BYTES);
    });

    it('produces different ciphertexts for the same plaintext', () => {
      // The visible consequence of the IV above: two tenants holding the same
      // token must not be identifiable by their ciphertexts matching.
      expect(seal('same value', key).ciphertext).not.toBe(
        seal('same value', key).ciphertext,
      );
    });

    it('refuses a value sealed under a different key', () => {
      const sealed = seal('bot-token-12345', key);
      expect(() => open(sealed, generateKey(), 'a test value')).toThrow(
        VaultDecryptionError,
      );
    });

    it('refuses a ciphertext that was edited', () => {
      // The reason GCM was chosen over an unauthenticated mode (ADR-0022): a
      // row edited directly in the database must fail, not decrypt to
      // something the editor chose.
      const sealed = seal('https://good.example/webhook', key);
      const raw = Buffer.from(sealed.ciphertext, 'base64');
      raw[0] ^= 0xff;
      expect(() =>
        open({ ...sealed, ciphertext: raw.toString('base64') }, key, 'a value'),
      ).toThrow(VaultDecryptionError);
    });

    it('refuses a value whose auth tag was replaced', () => {
      const sealed = seal('bot-token-12345', key);
      const otherTag = seal('bot-token-12345', key).authTag;
      expect(() => open({ ...sealed, authTag: otherTag }, key, 'a value')).toThrow(
        VaultDecryptionError,
      );
    });

    it('refuses a key that is not 32 bytes', () => {
      expect(() => seal('x', Buffer.alloc(16))).toThrow(/exactly 32 bytes/);
    });
  });

  describe('parseKey', () => {
    it('accepts a 32-byte key as base64 or as hex, and agrees on the bytes', () => {
      const raw = generateKey();
      expect(parseKey(raw.toString('base64'), 'k').equals(raw)).toBe(true);
      expect(parseKey(raw.toString('hex'), 'k').equals(raw)).toBe(true);
    });

    it('ignores the trailing newline a file inevitably has', () => {
      // `openssl rand -base64 32 > file` writes one. Failing on it would make
      // the documented way of producing the key the way of breaking it.
      const raw = generateKey();
      expect(parseKey(`${raw.toString('base64')}\n`, 'k').equals(raw)).toBe(true);
    });

    it('refuses a key of the wrong length instead of stretching it', () => {
      // `Buffer.from('too short', 'base64')` succeeds and yields 6 bytes. If
      // this did not throw, the service would boot under a key nobody chose.
      expect(() => parseKey('too short', 'k')).toThrow(/32-byte key/);
      expect(() => parseKey('', 'k')).toThrow(/empty/);
      expect(() => parseKey(Buffer.alloc(31).toString('base64'), 'k')).toThrow(
        /32-byte key/,
      );
    });

    it('names the key it is complaining about', () => {
      // The message reaches an operator at boot with no other context.
      expect(() => parseKey('nope', 'The vault KEK at /run/secrets/x')).toThrow(
        /The vault KEK at \/run\/secrets\/x/,
      );
    });
  });

  describe('fingerprint', () => {
    it('is stable for the same value and differs for another', () => {
      expect(fingerprint('token-a')).toBe(fingerprint('token-a'));
      expect(fingerprint('token-a')).not.toBe(fingerprint('token-b'));
    });

    it('is truncated, so a short credential is not brute-forceable from it', () => {
      // The whole reason it is truncated rather than a full SHA-256 (F-1214):
      // a fingerprint is shown to an admin, and a complete digest of a
      // six-character API key gives that value away.
      const fp = fingerprint('1234');
      expect(fp).toHaveLength(FINGERPRINT_HEX_CHARS);
      expect(fp).toMatch(/^[0-9a-f]+$/);
    });

    it('does not contain the value it fingerprints', () => {
      expect(fingerprint('supersecret')).not.toContain('supersecret');
    });

    it('is domain-separated from a bare hash of the same string', () => {
      // So a fingerprint can never be compared against — or mistaken for — a
      // digest produced anywhere else in the platform.
      const bare = require('node:crypto')
        .createHash('sha256')
        .update('token-a')
        .digest('hex')
        .slice(0, FINGERPRINT_HEX_CHARS);
      expect(fingerprint('token-a')).not.toBe(bare);
    });

    it('compares without throwing on different lengths', () => {
      // `timingSafeEqual` throws on a length mismatch; a stored fingerprint
      // from an older, shorter format must return false rather than crash.
      expect(fingerprintsMatch(fingerprint('a'), fingerprint('a'))).toBe(true);
      expect(fingerprintsMatch(fingerprint('a'), fingerprint('b'))).toBe(false);
      expect(fingerprintsMatch('abc', 'abcdef')).toBe(false);
    });
  });

  it('generates 32-byte keys', () => {
    expect(generateKey()).toHaveLength(KEY_BYTES);
    expect(generateKey().equals(generateKey())).toBe(false);
  });
});
