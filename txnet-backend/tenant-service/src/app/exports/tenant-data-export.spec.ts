import { gunzipSync } from 'node:zlib';

import { Prisma } from '@prisma/client';
import { ObjectStorage, ResellerAccess, type StoredObjectRow, verifySignedObject } from '@txnet-backend/shared-core';

import { exportPlan, modelOf, tableNameOf } from './export-archive';
import { EXPORT_TABLES } from './export-tables';
import { TenantDataExportDrain } from './tenant-data-export.drain';
import { DataExportRefused, TenantDataExportService } from './tenant-data-export.service';

/**
 * The invariants F-212-a turns on (catalog §14.8, `contract.data-export.md`).
 *
 * - A reseller's owner asks for an export in **every** status, terminated too;
 *   at most one not-failed request per 24 h; nobody else's request is taken.
 * - The drain builds one private gzip JSONL archive on the storage port, marks
 *   the export ready and tells the requester's page.
 * - The archive is handed out only as a signed URL of minutes, and that
 *   delivery is an audit row. An archive past its days is deleted.
 * - No credential column reaches the archive.
 */
describe('tenant data export', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STRANGER = '55555555-5555-5555-5555-555555555555';
  const SECRET = 'a-signing-secret-of-at-least-32-characters';
  const NOW = new Date('2026-10-22T10:00:00Z');
  const HOUR = 3_600_000;

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[], ip: '10.0.0.7' };
  const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };

  type Row = Record<string, unknown> & { id: string; tenantId: string; status: string; createdAt: Date };

  const build = (opts: { status?: string } = {}) => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform', ownerUserId: STRANGER, status: 'active', graceEndsAt: null, deletedAt: null },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: opts.status ?? 'active', graceEndsAt: null, deletedAt: null },
    };
    const exports: Row[] = [];
    const audits: Record<string, unknown>[] = [];
    const outbox: Record<string, unknown>[] = [];
    const objects = new Map<string, StoredObjectRow & { bytes?: Buffer }>();
    const matches = (row: Row, where: Record<string, unknown>): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(row, w));
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          const c = v as { not?: unknown; gt?: Date; lte?: Date; in?: unknown[] };
          if ('not' in c) return row[k] !== c.not;
          if (c.gt) return (row[k] as Date) > c.gt;
          if (c.lte) return row[k] !== null && (row[k] as Date) <= c.lte;
          if (c.in) return c.in.includes(row[k]);
        }
        return row[k] === v;
      });
    const newest = (where: Record<string, unknown>) =>
      exports.filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const tenantDataExport = {
      // Copies, as Prisma returns: a row read is not the row an update then changes.
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => newest(where).map((r) => ({ ...r }))[0] ?? null),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => newest(where).slice(0, take).map((r) => ({ ...r }))),
      create: vi.fn(async ({ data }: { data: { tenantId: string; requestedByUserId: string; createdAt: Date } }) => {
        const row = { id: `e${exports.length + 1}`, status: 'queued', attempts: 0, leaseUntil: null, objectKey: null, sizeBytes: null, rowCount: null, sha256: null, failureReason: null, finishedAt: null, expiresAt: null, ...data };
        exports.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = exports.filter((r) => matches(r, where));
        for (const r of hit) {
          for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] as number) + (v as { increment: number }).increment : v;
        }
        return { count: hit.length };
      }),
    };
    // One user row and one config row are all the archive meets; every other table is empty.
    const tableRows: Record<string, string[]> = {
      'identity.user': [JSON.stringify({ id: 'u1', tenantId: RESELLER, fullName: 'Sara' })],
      'network.config': [JSON.stringify({ id: 'c1', tenantId: RESELLER, protocol: 'vless' })],
    };
    let cursorTable: string | null = null;
    const tx = {
      tenantDataExport,
      adminAuditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (audits.push(data), { id: `a${audits.length}` })) },
      outboxEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (outbox.push(data), { id: 'o1' })) },
      storedObject: {
        upsert: vi.fn(async ({ create }: { create: StoredObjectRow }) => (objects.set(create.key, { ...create, ...objects.get(create.key) }), create)),
        findUnique: vi.fn(async ({ where }: { where: { key: string } }) => objects.get(where.key) ?? null),
        deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => ({ count: objects.delete(where.key) ? 1 : 0 })),
      },
      $executeRaw: vi.fn(async (sql: Prisma.Sql | TemplateStringsArray) => {
        const text = 'sql' in sql ? sql.sql : sql.join('?');
        if (text.startsWith('DECLARE')) cursorTable = Object.keys(tableRows).find((t) => text.includes(`"${t.split('.')[1]}" t0`)) ?? '';
        return 0;
      }),
      $queryRaw: vi.fn(async () => {
        const rows = cursorTable ? (tableRows[cursorTable] ?? []) : [];
        cursorTable = null;
        return rows.map((line) => ({ line }));
      }),
    };
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    const appPrisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
      tenantStaffMember: { findFirst: vi.fn(async () => null) },
      $transaction: prisma.$transaction,
    };
    const config = { get: () => SECRET };
    const service = new TenantDataExportService(new ResellerAccess(appPrisma as never), prisma as never, config as never);
    const bytes = new Map<string, Buffer>();
    const driver = {
      write: vi.fn(async (key: string, b: Buffer) => void bytes.set(key, b)),
      read: vi.fn(async (key: string) => bytes.get(key) ?? null),
      remove: vi.fn(async (key: string) => void bytes.delete(key)),
    };
    const storage = new ObjectStorage(driver, tx.storedObject as never);
    const drain = new TenantDataExportDrain(prisma as never, { tenantDataExport } as never, storage);
    return { service, drain, exports, audits, outbox, bytes, objects };
  };

  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof DataExportRefused) return e.reason;
      throw e;
    }
    return 'accepted';
  };

  it.each(['active', 'suspended', 'terminated'])('queues an export for the owner of a %s reseller, and audits the request', async (status) => {
    const { service, exports, audits } = build({ status });
    const view = await service.request(owner, RESELLER, NOW);
    expect(view.status).toBe('queued');
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ tenantId: RESELLER, requestedByUserId: OWNER });
    expect(audits).toEqual([expect.objectContaining({ tenantId: RESELLER, adminId: OWNER, action: 'tenant_data_export_request', targetEntityType: 'tenant_data_export', adminIpAddress: '10.0.0.7' })]);
  });

  it('refuses anyone the reseller does not admit', async () => {
    const { service, exports } = build();
    expect(await refusal(service.request(stranger, RESELLER, NOW))).toBe('not_allowed');
    expect(exports).toHaveLength(0);
  });

  it('takes one export per 24 hours, says when the next one opens, and does not count a failed one', async () => {
    const { service, exports } = build();
    await service.request(owner, RESELLER, NOW);
    const later = new Date(NOW.getTime() + 23 * HOUR);
    try {
      await service.request(owner, RESELLER, later);
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(DataExportRefused);
      expect((e as DataExportRefused).reason).toBe('export_too_soon');
      expect((e as DataExportRefused).nextAllowedAt?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    }
    expect((await service.list(owner, RESELLER, later)).nextAllowedAt).toBe('2026-10-23T10:00:00.000Z');
    exports[0].status = 'failed';
    expect((await service.request(owner, RESELLER, later)).status).toBe('queued');
  });

  it('builds a queued export into one private gzip JSONL archive, marks it ready and tells the requester', async () => {
    const { service, drain, exports, objects, bytes, outbox } = build({ status: 'terminated' });
    const { id } = await service.request(owner, RESELLER, NOW);
    expect(await drain.drain(NOW)).toEqual({ built: 1, failed: 0, expired: 0 });

    const row = exports[0];
    expect(row).toMatchObject({ status: 'ready', rowCount: 2, objectKey: `tenants/${RESELLER}/exports/${id}.jsonl.gz` });
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
    expect(objects.get(row.objectKey as string)).toMatchObject({ contentType: 'application/gzip', private: true });
    const lines = gunzipSync(bytes.get(row.objectKey as string) as Buffer).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].export).toMatchObject({ format: 'txnet-tenant-export/1', tenantId: RESELLER, exportId: id });
    expect(lines.slice(1, -1)).toEqual([
      { table: 'identity.user', row: { id: 'u1', tenantId: RESELLER, fullName: 'Sara' } },
      { table: 'network.config', row: { id: 'c1', tenantId: RESELLER, protocol: 'vless' } },
    ]);
    expect(lines.at(-1).end.rows).toBe(2);
    expect(outbox).toEqual([expect.objectContaining({ type: 'tenant.data_export.changed', payload: { userId: OWNER, resellerId: RESELLER, exportId: id } })]);
  });

  it('hands a ready archive out as a signed URL of at most five minutes, and audits that delivery', async () => {
    const { service, drain, audits } = build();
    const { id } = await service.request(owner, RESELLER, NOW);
    expect(await refusal(service.link(owner, RESELLER, id, NOW))).toBe('export_not_ready');
    await drain.drain(NOW);

    const link = await service.link(owner, RESELLER, id, NOW);
    const url = new URL(link.url, 'https://panel.example');
    const key = decodeURIComponent(url.pathname.split('/private-files/')[1]);
    const q = Object.fromEntries(url.searchParams) as { e: string; n: string; s: string };
    expect(verifySignedObject({ key, ...q, secret: SECRET, now: NOW })).toBe(true);
    expect(new Date(link.expiresAt).getTime() - NOW.getTime()).toBeLessThanOrEqual(5 * 60_000);
    expect(audits.at(-1)).toMatchObject({ action: 'tenant_data_export_delivery', targetEntityId: id, adminId: OWNER });
    expect(await refusal(service.link(stranger, RESELLER, id, NOW))).toBe('not_allowed');
    expect(await refusal(service.link(owner, RESELLER, '99999999-9999-9999-9999-999999999999', NOW))).toBe('export_not_found');
  });

  it('deletes an archive past its days and keeps the row as expired', async () => {
    const { service, drain, exports, bytes } = build();
    await service.request(owner, RESELLER, NOW);
    await drain.drain(NOW);
    const key = exports[0].objectKey as string;
    const after = new Date((exports[0].expiresAt as Date).getTime() + 1);
    expect(await drain.drain(after)).toEqual({ built: 0, failed: 0, expired: 1 });
    expect(exports[0]).toMatchObject({ status: 'expired', objectKey: null });
    expect(bytes.has(key)).toBe(false);
  });

  it('carries no credential: every column named like one is omitted, or its table is not exported', () => {
    // Columns that read like a secret and are not one: counters, public commitments, ids, flags.
    const harmless = new Set(['promptTokens', 'completionTokens', 'listHash', 'txHash', 'verifiedViaOtp', 'preferredOtpChannel', 'otpExpiresAt', 'otpAttemptCount', 'credentialGroupId', 'credentialId', 'tokenRotatedAt', 'private', 'keyFingerprint']);
    const credential = /[Ss]ecret|[Pp]assword|[Tt]oken|[Hh]ash|[Cc]ipher|[Ee]ncrypt|[Cc]redential|[Ww]rapped|[Pp]rivate|[Aa]pi[Kk]ey|^otp|Otp|[Uu]uid|[Ll]inkLines|sourceSnapshot|^path$/;
    const plan = exportPlan(RESELLER);
    const exported = new Map(plan.tables.map((t) => [t.name, t]));
    const leaks: string[] = [];
    for (const name of Object.keys(EXPORT_TABLES)) {
      const model = modelOf(name);
      const table = exported.get(tableNameOf(model));
      if (!table) continue;
      for (const f of model.fields) {
        const column = f.dbName ?? f.name;
        if (f.kind === 'object' || !credential.test(f.name) || harmless.has(f.name) || table.omit.includes(column)) continue;
        leaks.push(`${name}.${f.name}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
