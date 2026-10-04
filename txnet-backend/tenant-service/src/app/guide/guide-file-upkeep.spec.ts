/**
 * Storage upkeep (F-414-m, ADR-0120): a reseller's admins' files are held to
 * `storage_mib_max` — branding and guides, never its users' support
 * attachments, a replaced file not counted twice — and a guide file no text of
 * any tenant names is swept 7 days after upload, never sooner and never one a
 * reseller's override still shows.
 *
 * The limit's levels (reseller, package, platform, default, exempt) are
 * `reseller-limits.spec.ts`'s; this is the storage rule and the sweep.
 */
import { ResellerLimitReached, runWithTenant, storageQuotaBytes } from '@txnet-backend/shared-core';

import { storageRefusal } from '../files/storage-quota';
import { GUIDE_FILE_GRACE_DAYS, GuideFileSweep } from './guide-file-sweep';

const MIB = 1024 * 1024;
const P = '10000000-0000-4000-8000-000000000001'; // the platform
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const G = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const file = (tenant: string, name: string) => `tenants/${tenant}/guides/${G}/${name}`;

describe('the storage quota', () => {
  it('lets a file in that fits, and refuses one that would pass the limit with the MiB used', () => {
    expect(storageRefusal(10, 4 * MIB, 6 * MIB)).toBeNull();
    const refused = storageRefusal(10, 4 * MIB + 1, 6 * MIB);
    expect(refused).toBeInstanceOf(ResellerLimitReached);
    expect(refused?.facts).toEqual({ key: 'storage_mib_max', limit: 10, used: 5 });
  });

  it('has nothing to refuse with no limit — the platform, or a limit cleared', () => {
    expect(storageRefusal(null, 10_000 * MIB, 50 * MIB)).toBeNull();
  });

  it('counts the admins’ branding and guide files, not support attachments, and not the file being replaced', async () => {
    let where: any;
    const tx = { storedObject: { aggregate: async (q: any) => ((where = q.where), { _sum: { size: 7 } }) } };
    expect(await storageQuotaBytes(tx as never, A, `tenants/${A}/branding/logo`)).toBe(7);
    expect(where).toEqual({
      tenantId: A,
      OR: [{ key: { startsWith: `tenants/${A}/branding/` } }, { key: { startsWith: `tenants/${A}/guides/` } }],
      NOT: { key: `tenants/${A}/branding/logo` },
    });
  });
});

describe('the guide file sweep', () => {
  const NOW = new Date('2026-10-20T04:15:00Z');
  const old = new Date(NOW.getTime() - (GUIDE_FILE_GRACE_DAYS + 1) * 86_400_000);
  const young = new Date(NOW.getTime() - (GUIDE_FILE_GRACE_DAYS - 1) * 86_400_000);

  function harness(o: { objects: { key: string; tenantId: string; size: number; createdAt: Date }[]; texts: unknown[]; drafts?: unknown[] }) {
    const deleted: string[] = [];
    const scopes: string[] = [];
    const all = {
      storedObject: {
        findMany: async ({ where }: any) => o.objects.filter((x) => x.createdAt < where.createdAt.lt && x.key.includes(where.key.contains)),
      },
      guideTranslation: { findMany: async () => o.texts.map((blocks) => ({ blocks })) },
      guideDraft: { findMany: async () => (o.drafts ?? []).map((blocks) => ({ blocks })) },
    };
    const storage = {
      delete: async (key: string) => {
        deleted.push(key);
        const { TenantContext } = await import('@txnet-backend/shared-core');
        scopes.push(TenantContext.current('test').id);
      },
    };
    return { sweep: new GuideFileSweep(all as never, storage as never), deleted, scopes };
  }

  const image = (key: string) => [{ type: 'image', file: key, alt: 'a' }];

  it('deletes a guide file older than the grace that no text names, in its own tenant’s scope', async () => {
    const h = harness({ objects: [{ key: file(A, 'a.png'), tenantId: A, size: 3, createdAt: old }], texts: [] });
    expect(await h.sweep.sweep(NOW)).toEqual({ scanned: 1, deleted: 1, bytes: 3, kept: 0 });
    expect(h.deleted).toEqual([file(A, 'a.png')]);
    expect(h.scopes).toEqual([A]);
  });

  it('keeps a file a published text or a draft names — a reseller’s override draft naming the platform’s file too', async () => {
    const h = harness({
      objects: [
        { key: file(P, 'shown.png'), tenantId: P, size: 1, createdAt: old },
        { key: file(P, 'overridden.png'), tenantId: P, size: 1, createdAt: old },
      ],
      texts: [image(file(P, 'shown.png'))],
      drafts: [image(file(P, 'overridden.png'))],
    });
    expect(await h.sweep.sweep(NOW)).toEqual({ scanned: 2, deleted: 0, bytes: 0, kept: 2 });
  });

  it('never touches a file younger than the grace — an editor may be about to save it', async () => {
    const h = harness({ objects: [{ key: file(B, 'new.png'), tenantId: B, size: 1, createdAt: young }], texts: [] });
    expect((await h.sweep.sweep(NOW)).deleted).toBe(0);
  });

  it('sweeps only guide files, never branding or support’s', async () => {
    const h = harness({
      objects: [
        { key: `tenants/${A}/branding/logo`, tenantId: A, size: 1, createdAt: old },
        { key: `tenants/${A}/support/x/guides/y.png`, tenantId: A, size: 1, createdAt: old },
      ],
      texts: [],
    });
    expect(await h.sweep.sweep(NOW)).toEqual({ scanned: 0, deleted: 0, bytes: 0, kept: 0 });
  });

  it('deletes nothing when a text cannot be read — it cannot tell which files that text names', async () => {
    const h = harness({ objects: [{ key: file(A, 'a.png'), tenantId: A, size: 1, createdAt: old }], texts: [[{ type: 'unknown' }]] });
    await expect(h.sweep.sweep(NOW)).rejects.toThrow(/unreadable/);
    expect(h.deleted).toEqual([]);
  });

  it('runs outside any request — its own scope per file, none left open', async () => {
    const h = harness({ objects: [{ key: file(A, 'a.png'), tenantId: A, size: 1, createdAt: old }], texts: [] });
    await runWithTenant({ id: B }, () => h.sweep.sweep(NOW));
    expect(h.scopes).toEqual([A]);
  });
});
