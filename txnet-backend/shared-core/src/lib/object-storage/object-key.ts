/**
 * The address of a stored file (F-018-m, D-42 (3)).
 *
 * `tenants/<tenantId>/<logical path>` — the same string is a path under the
 * `local` driver's root and an object key in a bucket, which is what makes
 * moving to S3 a copy by key and a driver switch with no row rewritten.
 *
 * Pure, and separate from the port, so the one rule every driver and the
 * serving route read can be asserted without a disk.
 */

const PREFIX = 'tenants';

/** A tenant id as `tenant.id` is written: a lower-case UUID. */
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One or more lower-case segments, each starting with a letter or digit — so
 * `.`, `..`, an empty segment and a leading `/` are all unspellable, and a key
 * cannot climb out of its tenant's prefix on any driver.
 */
const LOGICAL_PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** Long enough for any path a caller composes; short of every filesystem's limit. */
const MAX_PATH_LENGTH = 200;

export function isLogicalPath(path: string): boolean {
  return path.length <= MAX_PATH_LENGTH && LOGICAL_PATH.test(path);
}

/** The key for `path` in `tenantId`'s prefix. Throws on a path that is not one. */
export function objectKey(tenantId: string, path: string): string {
  if (!TENANT_ID.test(tenantId)) throw new Error(`not a tenant id: ${tenantId}`);
  if (!isLogicalPath(path)) throw new Error(`not a logical path: ${JSON.stringify(path)}`);
  return `${PREFIX}/${tenantId}/${path}`;
}

/**
 * The tenant and path a key names, or `null` for anything that is not a key
 * {@link objectKey} could have built. The serving route reads a key straight
 * from a URL, so this is the gate between a stranger's string and a path on
 * disk.
 */
export function parseObjectKey(key: string): { tenantId: string; path: string } | null {
  const [prefix, tenantId, ...rest] = key.split('/');
  const path = rest.join('/');
  if (prefix !== PREFIX || !tenantId || !TENANT_ID.test(tenantId) || !isLogicalPath(path)) {
    return null;
  }
  return { tenantId, path };
}
