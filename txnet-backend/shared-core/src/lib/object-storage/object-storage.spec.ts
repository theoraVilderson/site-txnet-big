import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TenantContextMissing,
  TenantScopeConflict,
  runWithTenant,
} from '../tenant-context/tenant-context';
import { objectKey, parseObjectKey } from './object-key';
import {
  LocalObjectDriver,
  ObjectNotFound,
  ObjectRejected,
  ObjectStorage,
  objectDriverFromEnv,
  type StoredObjectRow,
  type StoredObjectStore,
  type UploadPolicy,
} from './object-storage';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const LOGO: UploadPolicy = { types: ['image/png', 'image/webp'], maxBytes: 64 };

/** `stored_object` as the scoped client answers it: rows by key. */
function memoryStore(): StoredObjectStore & { rows: Map<string, StoredObjectRow> } {
  const rows = new Map<string, StoredObjectRow>();
  return {
    rows,
    async upsert({ where, create, update }) {
      const row = { ...(rows.get(where.key) ?? create), ...update } as StoredObjectRow;
      rows.set(where.key, row);
      return row;
    },
    async findUnique({ where }) {
      const row = rows.get(where.key);
      return row && row.tenantId === where.tenantId ? row : null;
    },
    async deleteMany({ where }) {
      const had = rows.get(where.key)?.tenantId === where.tenantId;
      if (had) rows.delete(where.key);
      return { count: had ? 1 : 0 };
    },
  };
}

describe('object-storage (F-018-m)', () => {
  let root: string;
  let store: ReturnType<typeof memoryStore>;
  let storage: ObjectStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'objects-'));
    store = memoryStore();
    storage = new ObjectStorage(new LocalObjectDriver(root), store);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const asA = <T>(fn: () => T) => runWithTenant({ id: A }, fn);

  it('keys a file by the tenant in scope, and the key is its path on the volume', async () => {
    const put = await asA(() => storage.put(LOGO, 'branding/logo-light.png', PNG, 'image/png'));

    expect(put.key).toBe(`tenants/${A}/branding/logo-light.png`);
    expect(await readFile(join(root, put.key))).toEqual(PNG);
    expect(store.rows.get(put.key)).toMatchObject({
      tenantId: A,
      contentType: 'image/png',
      size: PNG.length,
      sha256: put.sha256,
    });
    expect(put.sha256).toMatch(/^[0-9a-f]{64}$/);

    const got = await asA(() => storage.get(put.key));
    expect(got.bytes).toEqual(PNG);
    expect(got.contentType).toBe('image/png');
  });

  it('replaces a file put again at the same path', async () => {
    await asA(() => storage.put(LOGO, 'branding/logo.webp', WEBP, 'image/webp'));
    const again = Buffer.concat([WEBP, Buffer.from('x')]);
    const put = await asA(() => storage.put(LOGO, 'branding/logo.webp', again, 'image/webp'));

    expect((await asA(() => storage.get(put.key))).bytes).toEqual(again);
    expect(store.rows.get(put.key)?.size).toBe(again.length);
  });

  it.each([
    ['a type the policy does not name', PNG, 'image/jpeg', 'type_not_allowed'],
    ['SVG, which no policy can name', HTML, 'image/svg+xml', 'type_not_allowed'],
    ['bytes that are not what they claim', HTML, 'image/png', 'type_mismatch'],
    ['a file over the cap', Buffer.concat([PNG, Buffer.alloc(64)]), 'image/png', 'too_large'],
    ['an empty file', Buffer.alloc(0), 'image/png', 'type_mismatch'],
  ])('refuses %s, and writes nothing', async (_, bytes, type, reason) => {
    await expect(asA(() => storage.put(LOGO, 'branding/x.png', bytes, type))).rejects.toMatchObject({
      name: ObjectRejected.name,
      reason,
    });
    expect(store.rows.size).toBe(0);
    await expect(stat(join(root, 'tenants'))).rejects.toThrow();
  });

  it.each(['../escape.png', '/abs.png', 'a//b.png', 'Upper.png', 'a/./b.png', 'a/../b.png', ''])(
    'refuses the logical path %j',
    async (path) => {
      await expect(asA(() => storage.put(LOGO, path, PNG, 'image/png'))).rejects.toMatchObject({
        reason: 'bad_path',
      });
    },
  );

  it('refuses a policy that allows nothing, rather than defaulting one', async () => {
    await expect(
      asA(() => storage.put({ types: [], maxBytes: 64 }, 'x.png', PNG, 'image/png')),
    ).rejects.toThrow(/policy/);
  });

  it("will not read, stat or delete another tenant's key", async () => {
    const key = (await asA(() => storage.put(LOGO, 'branding/a.png', PNG, 'image/png'))).key;

    await runWithTenant({ id: B }, async () => {
      await expect(storage.get(key)).rejects.toBeInstanceOf(TenantScopeConflict);
      await expect(storage.stat(key)).rejects.toBeInstanceOf(TenantScopeConflict);
      await expect(storage.delete(key)).rejects.toBeInstanceOf(TenantScopeConflict);
    });
    expect(await readFile(join(root, key))).toEqual(PNG);
  });

  it('needs a tenant in scope for every operation', async () => {
    await expect(storage.put(LOGO, 'a.png', PNG, 'image/png')).rejects.toBeInstanceOf(TenantContextMissing);
    await expect(storage.get(objectKey(A, 'a.png'))).rejects.toBeInstanceOf(TenantContextMissing);
  });

  it('deletes the row and the bytes; the key is then not found', async () => {
    const key = (await asA(() => storage.put(LOGO, 'branding/a.png', PNG, 'image/png'))).key;
    await asA(() => storage.delete(key));

    expect(store.rows.has(key)).toBe(false);
    await expect(stat(join(root, key))).rejects.toThrow();
    await expect(asA(() => storage.get(key))).rejects.toBeInstanceOf(ObjectNotFound);
    await expect(asA(() => storage.stat(key))).resolves.toBeNull();
    await expect(asA(() => storage.delete(key))).rejects.toBeInstanceOf(ObjectNotFound);
  });

  it('reads no key that is not tenant-prefixed or that climbs out of it', () => {
    expect(parseObjectKey(`tenants/${A}/branding/a.png`)).toEqual({ tenantId: A, path: 'branding/a.png' });
    for (const key of [
      `tenants/${A}/../${B}/a.png`,
      `tenants/${A}/`,
      `tenants/not-a-uuid/a.png`,
      `/tenants/${A}/a.png`,
      `branding/a.png`,
      `tenants/ABCDEF01-1111-4111-8111-111111111111/a.png`,
    ]) {
      expect(parseObjectKey(key), key).toBeNull();
    }
  });

  it('picks the driver from the environment, and refuses one it does not have', () => {
    expect(objectDriverFromEnv({ OBJECT_STORAGE_DRIVER: 'local', OBJECT_STORAGE_LOCAL_ROOT: root })).toBeInstanceOf(
      LocalObjectDriver,
    );
    expect(() => objectDriverFromEnv({ OBJECT_STORAGE_DRIVER: 'local' })).toThrow(/OBJECT_STORAGE_LOCAL_ROOT/);
    expect(() => objectDriverFromEnv({ OBJECT_STORAGE_DRIVER: 's3', OBJECT_STORAGE_LOCAL_ROOT: root })).toThrow(
      /s3/,
    );
  });
});
