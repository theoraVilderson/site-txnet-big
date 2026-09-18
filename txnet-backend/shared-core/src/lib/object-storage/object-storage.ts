import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { TenantContext, TenantScopeConflict } from '../tenant-context/tenant-context';
import { isLogicalPath, objectKey, parseObjectKey } from './object-key';

/**
 * Object storage (F-018-m, D-42 (3), `docs/platform/object-storage/`).
 *
 * One port for every uploaded file — branding today, ticket attachments later.
 * A caller holds a **key**, never a path or a URL: the bytes sit behind an
 * {@link ObjectDriver} chosen by the environment, and the `stored_object` row
 * records what the bytes are, so moving to a bucket is a copy by key and a
 * driver switch, verified against `sha256`.
 */

/**
 * The content types a policy may allow: exactly the ones whose bytes can be
 * checked here. A type is added by adding its signature — SVG has none, so no
 * policy can let one in (catalog 13.8: branding is PNG/WebP, never SVG).
 */
export const SNIFFABLE_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const;
export type SniffableType = (typeof SNIFFABLE_TYPES)[number];

const SIGNATURES: Record<SniffableType, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
};

/**
 * What one use of the port accepts (rule 4). Declared by the caller, never
 * defaulted: a default would be the policy of whichever use came first.
 */
export interface UploadPolicy {
  types: readonly SniffableType[];
  maxBytes: number;
}

export type RejectReason = 'bad_path' | 'type_not_allowed' | 'type_mismatch' | 'too_large';

/** A `put` the policy refused. Nothing was written. */
export class ObjectRejected extends Error {
  constructor(readonly reason: RejectReason) {
    super(`object rejected: ${reason}`);
    this.name = 'ObjectRejected';
  }
}

/** No stored object at this key, in the tenant in scope. */
export class ObjectNotFound extends Error {
  constructor(readonly key: string) {
    super(`no stored object at ${key}`);
    this.name = 'ObjectNotFound';
  }
}

/** Where the bytes are. Knows keys and bytes, and nothing about tenants or types. */
export interface ObjectDriver {
  write(key: string, bytes: Buffer): Promise<void>;
  /** The bytes, or `null` when the key holds none. */
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

/**
 * A directory on a mounted volume; the key is the path under it.
 *
 * **One node, or a volume every replica shares** (rule 5): replicas on
 * separate disks each hold a different subset of the files.
 */
export class LocalObjectDriver implements ObjectDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async write(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    // Written aside and renamed, so a reader never sees half a file and a
    // replaced logo is swapped whole.
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, path);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /** A key that parsed is already confined; the prefix check holds it if the parser ever loosens. */
  private pathOf(key: string): string {
    const path = resolve(this.root, key);
    if (!parseObjectKey(key) || !path.startsWith(this.root + sep)) {
      throw new Error(`not an object key: ${JSON.stringify(key)}`);
    }
    return path;
  }
}

/** The environment a driver is chosen from. */
export interface ObjectStorageEnv {
  OBJECT_STORAGE_DRIVER?: string;
  OBJECT_STORAGE_LOCAL_ROOT?: string;
}

/** The driver the environment names. An S3-compatible one arrives behind the same port. */
export function objectDriverFromEnv(env: ObjectStorageEnv): ObjectDriver {
  const driver = env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver !== 'local') {
    throw new Error(`OBJECT_STORAGE_DRIVER=${driver} is not built; only "local" is`);
  }
  if (!env.OBJECT_STORAGE_LOCAL_ROOT) {
    throw new Error('OBJECT_STORAGE_LOCAL_ROOT must name the mounted volume for the local driver');
  }
  return new LocalObjectDriver(env.OBJECT_STORAGE_LOCAL_ROOT);
}

/** A `stored_object` row (rule 3). */
export interface StoredObjectRow {
  key: string;
  tenantId: string;
  contentType: string;
  size: number;
  sha256: string;
}

type RowKey = { key: string; tenantId: string };

/**
 * The three queries the port makes on `stored_object`. On a service's
 * `PrismaService` they are also scoped by `withTenant` and RLS; the port names
 * the tenant itself as well, as the vault does.
 */
export interface StoredObjectStore {
  upsert(args: { where: RowKey; create: StoredObjectRow; update: Omit<StoredObjectRow, 'key' | 'tenantId'> }): Promise<StoredObjectRow>;
  findUnique(args: { where: RowKey }): Promise<StoredObjectRow | null>;
  deleteMany(args: { where: RowKey }): Promise<{ count: number }>;
}

/** {@link StoredObjectStore} on a Prisma client — the service's scoped one. */
export function prismaStoredObjects(client: Pick<PrismaClient, 'storedObject'>): StoredObjectStore {
  return {
    upsert: (args) => client.storedObject.upsert(args),
    findUnique: (args) => client.storedObject.findUnique(args),
    deleteMany: (args) => client.storedObject.deleteMany(args),
  };
}

export interface PutResult {
  key: string;
  sha256: string;
  size: number;
}

export class ObjectStorage {
  constructor(
    private readonly driver: ObjectDriver,
    private readonly rows: StoredObjectStore,
  ) {}

  /**
   * Store `bytes` at `path` in the tenant in scope, replacing what was there.
   * The declared type must be one the policy allows **and** what the bytes
   * are: a type is served back as stored, so an HTML page declared a PNG would
   * otherwise be served as whatever a browser guessed.
   */
  async put(policy: UploadPolicy, path: string, bytes: Buffer, contentType: string): Promise<PutResult> {
    if (policy.types.length === 0 || !(policy.maxBytes > 0)) {
      throw new Error('an upload policy must name its types and a positive maxBytes');
    }
    const tenantId = TenantContext.current('object-storage put').id;
    if (!isLogicalPath(path)) throw new ObjectRejected('bad_path');
    const type = policy.types.find((t) => t === contentType);
    if (!type) throw new ObjectRejected('type_not_allowed');
    if (bytes.length > policy.maxBytes) throw new ObjectRejected('too_large');
    if (!SIGNATURES[type](bytes)) throw new ObjectRejected('type_mismatch');

    const key = objectKey(tenantId, path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const facts = { contentType: type, size: bytes.length, sha256 };
    // Bytes first: a row with no bytes is a broken file on every page that
    // shows it; bytes with no row are an orphan the next put overwrites.
    await this.driver.write(key, bytes);
    await this.rows.upsert({ where: { key, tenantId }, create: { key, tenantId, ...facts }, update: facts });
    return { key, sha256, size: bytes.length };
  }

  /** The row for `key`, or `null`. */
  async stat(key: string): Promise<StoredObjectRow | null> {
    return this.rows.findUnique({ where: { key, tenantId: this.ownerOf(key, 'stat') } });
  }

  async get(key: string): Promise<StoredObjectRow & { bytes: Buffer }> {
    const row = await this.stat(key);
    const bytes = row && (await this.driver.read(key));
    if (!row || !bytes) throw new ObjectNotFound(key);
    return { ...row, bytes };
  }

  async delete(key: string): Promise<void> {
    const { count } = await this.rows.deleteMany({ where: { key, tenantId: this.ownerOf(key, 'delete') } });
    if (count === 0) throw new ObjectNotFound(key);
    // Row first, the mirror of `put`: a file with no row is an orphan, a row
    // with no file is a broken image.
    await this.driver.remove(key);
  }

  /**
   * The tenant in scope, when `key` is in its prefix. Another tenant's key is
   * a conflict and not a miss: the caller named something it does not own,
   * which is a bug to surface, not an absence to render.
   */
  private ownerOf(key: string, op: string): string {
    const tenantId = TenantContext.current(`object-storage ${op}`).id;
    const parsed = parseObjectKey(key);
    if (!parsed) throw new ObjectNotFound(key);
    if (parsed.tenantId !== tenantId) {
      throw new TenantScopeConflict(`object-storage ${op} of ${key}`, tenantId, parsed.tenantId);
    }
    return tenantId;
  }
}
