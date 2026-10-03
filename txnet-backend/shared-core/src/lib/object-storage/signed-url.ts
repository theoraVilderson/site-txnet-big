import { createHmac, timingSafeEqual } from 'node:crypto';

import { publicPath } from '../tenant/public-route';

/**
 * Signed URLs for private files (F-033-c, ADR-0113).
 *
 * A private file has no public address. Its owner's service checks who may see
 * it, then mints a URL that names the key, the file name it is saved as and an
 * expiry, sealed with an HMAC both the minting service and tenant-service's
 * `private-files` route hold. The URL is the whole permission: it carries no
 * session, so a bot can hand it to Telegram, and it dies in minutes.
 *
 * Nothing is stored: a URL is minted on every read (ADR-0112 point 7).
 */

/** `GET /api/public/tenant/private-files/<key>?e=&n=&s=` (tenant-service; the controller path, under `api`). */
export const PRIVATE_FILES_PATH = publicPath('tenant', 'private-files');

/** Every service's `GLOBAL_PREFIX` in compose; the URL is read by a browser, so it is spelled whole. */
const API_PREFIX = 'api';

/** An HMAC key shorter than this is a placeholder, not a secret. */
const SECRET_MIN = 32;

export interface SignInput {
  key: string;
  /** What the browser saves it as; signed, so a link cannot be renamed. */
  fileName: string;
  ttlSec: number;
  secret: string;
  now?: Date;
}

export interface SignedObjectUrl {
  /** A path on the caller's own Host — the route serves the Host's tenant only. */
  url: string;
  expiresAt: Date;
}

export function signedObjectUrl(input: SignInput): SignedObjectUrl {
  assertSecret(input.secret);
  const now = input.now ?? new Date();
  const e = Math.floor(now.getTime() / 1000) + input.ttlSec;
  const s = signature(input.key, String(e), input.fileName, input.secret);
  const query = new URLSearchParams({ e: String(e), n: input.fileName, s });
  const path = input.key.split('/').map(encodeURIComponent).join('/');
  return { url: `/${API_PREFIX}/${PRIVATE_FILES_PATH}/${path}?${query.toString()}`, expiresAt: new Date(e * 1000) };
}

export interface VerifyInput {
  key: string;
  /** Expiry, unix seconds, as the URL carries it. */
  e: string;
  n: string;
  s: string;
  secret: string;
  now?: Date;
}

/** True only for an unexpired URL whose key, name and expiry are what was signed. */
export function verifySignedObject(input: VerifyInput): boolean {
  if (input.secret.length < SECRET_MIN || !/^\d{1,12}$/.test(input.e) || !/^[0-9a-f]{64}$/.test(input.s)) {
    return false;
  }
  const now = input.now ?? new Date();
  if (Number(input.e) * 1000 < now.getTime()) return false;
  const expected = Buffer.from(signature(input.key, input.e, input.n, input.secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(input.s, 'hex'));
}

function signature(key: string, e: string, n: string, secret: string): string {
  // Newline-separated: a key, a number and a name cannot run into each other.
  return createHmac('sha256', secret).update(`${key}\n${e}\n${n}`).digest('hex');
}

function assertSecret(secret: string): void {
  if (secret.length < SECRET_MIN) {
    throw new Error(`OBJECT_STORAGE_SIGNING_SECRET must be at least ${SECRET_MIN} characters`);
  }
}
