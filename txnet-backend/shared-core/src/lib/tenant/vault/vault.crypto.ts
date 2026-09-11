import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * The vault's cryptography, with nothing else in it (ADR-0026, catalog 20.4).
 *
 * Pure functions over buffers and strings: no Prisma, no Nest, no config. That
 * split is the same one `tenant.ts`'s `normalizeHost` makes, and it is worth
 * more here than there — this is the file where a mistake is silent. A wrong
 * IV length or a dropped auth tag does not throw at the call site, it produces
 * a ciphertext that decrypts to garbage or, worse, one an attacker can edit.
 * Asserting that without a database is what `vault.crypto.spec.ts` does.
 */

/** AES-256: a 32-byte key, and nothing else is accepted. */
export const KEY_BYTES = 32;

/**
 * 12 bytes, which is GCM's own nonce size. Any other length forces Node to
 * hash the value into one, which is legal and loses the guarantee this file
 * cares about: that a fresh random IV per record cannot repeat.
 */
export const IV_BYTES = 12;

const ALGORITHM = 'aes-256-gcm';

/**
 * How much of the plaintext hash a fingerprint keeps, in hex characters.
 *
 * 16 hex characters is 64 bits. The fingerprint is shown to an admin, so it
 * has to be short enough to compare by eye, and it must not be reversible into
 * the credential. Truncation is what buys the second property against a *short
 * or low-entropy* secret: a full SHA-256 of a six-character API key is
 * brute-forceable in seconds, and publishing it would hand the value over.
 * At 64 bits a collision is still far beyond what a tenant's own credential
 * set can reach, so "same fingerprint" remains a usable answer to "is this the
 * value you already have?".
 */
export const FINGERPRINT_HEX_CHARS = 16;

/**
 * A domain separator, so a vault fingerprint can never be confused with — or
 * compared against — a hash of the same string produced anywhere else in the
 * platform.
 */
const FINGERPRINT_DOMAIN = 'txnet:vault:fingerprint:v1';

/** A sealed value: the ciphertext, the IV it used, and its auth tag. */
export interface SealedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Thrown when a stored value fails to decrypt — a wrong key, or a tampered row. */
export class VaultDecryptionError extends Error {
  /**
   * The underlying OpenSSL failure. Declared here rather than relying on
   * `Error.cause`, which this `lib` target does not type — and kept because
   * the original carries which stage failed, while saying nothing about the
   * value, so it is safe to log.
   */
  readonly reason?: unknown;

  constructor(what: string, reason?: unknown) {
    super(
      `Could not decrypt ${what}. The key is wrong, or the stored value was ` +
        `modified outside this service — GCM authenticates the ciphertext, so ` +
        `it refuses rather than returning something an attacker chose.`,
    );
    this.name = 'VaultDecryptionError';
    this.reason = reason;
  }
}

/** A fresh 256-bit key. Used for a DEK; the KEK comes from the secret file. */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Read a 32-byte key out of its stored form — base64 or hex, whichever the
 * operator wrote into the Swarm secret.
 *
 * Both encodings are accepted because Node's `Buffer.from` silently *succeeds*
 * on the wrong one: hex parsed as base64 yields a shorter buffer rather than
 * an error, and the service would then boot with a key nobody chose. The
 * length check below is what turns that into a refusal, so it is the point of
 * this function rather than a guard on it.
 */
export function parseKey(raw: string, what: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${what} is empty. It must be a ${KEY_BYTES}-byte key.`);
  }

  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    candidates.push(Buffer.from(trimmed, 'hex'));
  }
  candidates.push(Buffer.from(trimmed, 'base64'));

  const key = candidates.find((c) => c.length === KEY_BYTES);
  if (!key) {
    throw new Error(
      `${what} is not a ${KEY_BYTES}-byte key. Give it ${KEY_BYTES} bytes as ` +
        `base64 or hex — for example \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

/** Seal a value under a key. A fresh IV every time, never derived, never reused. */
export function seal(plaintext: string, key: Buffer): SealedValue {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Open a sealed value. Throws {@link VaultDecryptionError} when the key is
 * wrong or the row was edited — which is the property GCM is chosen for
 * (ADR-0022, carried into ADR-0026).
 */
export function open(sealed: SealedValue, key: Buffer, what: string): string {
  assertKey(key);
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(sealed.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    // Deliberately not re-thrown: the original carries the OpenSSL message and
    // nothing about the value, but wrapping it keeps every caller's failure
    // one type and one sentence.
    throw new VaultDecryptionError(what, err);
  }
}

/**
 * The truncated hash an admin surface may see (F-1214).
 *
 * Answers "is this the same value I already have?" without revealing the
 * value, which is what lets the vault refuse to ever show a credential back
 * and still be usable.
 */
export function fingerprint(plaintext: string): string {
  return createHash('sha256')
    .update(FINGERPRINT_DOMAIN)
    .update('\0')
    .update(plaintext, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_CHARS);
}

/**
 * Compare two fingerprints without leaking, through timing, how many
 * characters matched.
 *
 * A fingerprint is not itself a secret, so this is belt-and-braces rather than
 * load-bearing — but "is this the same value?" is asked with a caller-supplied
 * plaintext, and an equality that returns early is the shape that turns a
 * public digest into an oracle for the value behind it.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `A vault key must be exactly ${KEY_BYTES} bytes; got ${key.length}.`,
    );
  }
}
