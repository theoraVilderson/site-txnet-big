/**
 * Gift-code batches (F-502-d, D-33): N single-use `wallet_credit` codes made in
 * one go, listed, exported and switched off together.
 *
 *  - **a code is a bearer credit.** Anyone holding it takes the money, so it
 *    comes from a CSPRNG over an alphabet a person cannot misread (no 0/O,
 *    1/I/L), it never lands in an audit row, and exporting a batch is itself
 *    audited;
 *  - **a collision is retried, not dropped.** A batch of N is N codes: a
 *    candidate already live in the same scope is drawn again;
 *  - **ownership** is coupon management's (F-502-c): another tenant's batch is
 *    not found, a platform batch is the platform owner's;
 *  - **deactivating a batch** switches every live code in it off at once.
 */
import { DiscountType, TenantType } from '@prisma/client';

import { CouponAdminRefused, CouponAdminService } from './coupon-admin.service';
import { CouponBatchService, GIFT_CODE_ALPHABET } from './coupon-batch.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const OTHER_BATCH = '55555555-5555-4555-8555-555555555555';

const actor = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v !== null && typeof v === 'object' && 'in' in (v as Row)) return (v as { in: unknown[] }).in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

function table(rows: Row[], name: string, writes: string[]) {
  let next = 0;
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      writes.push(`${name}.create`);
      const row = { id: `${name}-${next++}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      writes.push(`${name}.createMany`);
      rows.push(...data.map((d) => ({ id: `${name}-${next++}`, usedCount: 0, reservedCount: 0, deletedAt: null, ...d })));
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.update`);
      return Object.assign(rows.find((r) => matches(r, where)) as Row, data);
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.updateMany`);
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    groupBy: async ({ where }: { where: Row }) => {
      const by = new Map<unknown, Row[]>();
      for (const r of rows.filter((x) => matches(x, where))) by.set(r['batchId'], [...(by.get(r['batchId']) ?? []), r]);
      return [...by.entries()].map(([batchId, list]) => ({
        batchId,
        _count: { _all: list.length },
        _sum: { usedCount: list.reduce((a, r) => a + Number(r['usedCount']), 0), reservedCount: list.reduce((a, r) => a + Number(r['reservedCount']), 0) },
      }));
    },
  };
}

function build() {
  const writes: string[] = [];
  const audit: Row[] = [];
  const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };
  const db = {
    tenant: table(Object.entries(types).map(([id, tenantType]) => ({ id, tenantType })), 'tenant', writes),
    coupon: table([{ id: 'live', tenantId: RESELLER, code: 'TAKEN-AAAAAAAAAA', deletedAt: null, usedCount: 0, reservedCount: 0, isActive: true }], 'coupon', writes),
    couponBatch: table([{ id: OTHER_BATCH, tenantId: OTHER, label: 'theirs', createdAt: new Date(), deactivatedAt: null }], 'couponBatch', writes),
    couponTenant: table([], 'couponTenant', writes),
    adminAuditLog: {
      create: async ({ data }: { data: Row }) => {
        writes.push('audit');
        audit.push(data);
        return data;
      },
    },
  };
  const all = { ...db, $transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db) };
  const app = { tenant: { findUnique: async ({ where }: { where: Row }) => (types[where['id'] as string] ? { tenantType: types[where['id'] as string] } : null) } };
  const coupons = new CouponAdminService(app as never, all as never);
  return { service: new CouponBatchService(coupons, all as never), db, writes, audit };
}

async function refusal(run: () => Promise<unknown>): Promise<CouponAdminRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof CouponAdminRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const BATCH = { label: 'Yalda giveaway', count: 25, value: '5' };

describe('CouponBatchService — generate', () => {
  it('makes N distinct single-use wallet-credit codes over the unambiguous alphabet, and audits none of them', async () => {
    const { service, db, audit } = build();
    const batch = await service.generate(actor(RESELLER), { ...BATCH, prefix: 'yld' });
    const codes = db.coupon.rows.filter((r) => r['batchId'] === batch.id);
    expect(codes).toHaveLength(25);
    expect(new Set(codes.map((c) => c['code'])).size).toBe(25);
    for (const c of codes) {
      expect(c).toMatchObject({ tenantId: RESELLER, discountType: DiscountType.wallet_credit, totalUsageLimit: 1, perUserUsageLimit: 1, createdByAdminId: ADMIN });
      const [prefix, body] = String(c['code']).split('-');
      expect(prefix).toBe('YLD');
      expect([...body].every((ch) => GIFT_CODE_ALPHABET.includes(ch))).toBe(true);
      expect(body).toHaveLength(10);
    }
    expect(GIFT_CODE_ALPHABET).not.toMatch(/[0O1IL]/);
    expect(audit).toEqual([expect.objectContaining({ action: 'coupon_batch_create', targetEntityType: 'coupon_batch', targetEntityId: batch.id, tenantId: RESELLER })]);
    const trail = JSON.stringify(audit);
    for (const c of codes) expect(trail).not.toContain(String(c['code']));
  });

  it('draws a candidate again when it collides with a live code in the same scope', async () => {
    const { service, db } = build();
    const draws = ['AAAAAAAAAA', 'AAAAAAAAAA', 'BBBBBBBBBB'];
    (service as unknown as { randomBody: () => string }).randomBody = () => draws.shift() ?? 'CCCCCCCCCC';
    const batch = await service.generate(actor(RESELLER), { ...BATCH, prefix: 'TAKEN', count: 2 });
    const codes = db.coupon.rows.filter((r) => r['batchId'] === batch.id).map((r) => r['code']);
    expect(codes.sort()).toEqual(['TAKEN-BBBBBBBBBB', 'TAKEN-CCCCCCCCCC']);
  });

  it('refuses a platform batch to a reseller, and a count or value out of range', async () => {
    const { service } = build();
    expect((await refusal(() => service.generate(actor(RESELLER), { ...BATCH, tenantId: null }))).reason).toBe('not_platform_owner');
    expect((await refusal(() => service.generate(actor(RESELLER), { ...BATCH, count: 0 }))).reason).toBe('invalid_batch');
    expect((await refusal(() => service.generate(actor(RESELLER), { ...BATCH, count: 5001 }))).reason).toBe('invalid_batch');
    expect((await refusal(() => service.generate(actor(RESELLER), { ...BATCH, value: '0' }))).reason).toBe('invalid_value');
  });
});

describe('CouponBatchService — list, export, deactivate', () => {
  it('lists only the caller’s batches with their counts', async () => {
    const { service, db } = build();
    const batch = await service.generate(actor(RESELLER), { ...BATCH, count: 3 });
    db.coupon.rows.find((r) => r['batchId'] === batch.id)!['usedCount'] = 1;
    const page = await service.list(actor(RESELLER), {});
    expect(page.items).toEqual([expect.objectContaining({ id: batch.id, codes: 3, used: 1, reserved: 0 })]);
  });

  it('exports a batch as CSV, audited, and never another tenant’s', async () => {
    const { service, audit } = build();
    const batch = await service.generate(actor(RESELLER), { ...BATCH, count: 4, expiresAt: '2027-01-01T00:00:00.000Z' });
    const csv = await service.exportCsv(actor(RESELLER), batch.id);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('code,value,expires_at,status,used');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/^[A-Z2-9]{10},5\.00,2027-01-01T00:00:00\.000Z,active,0$/);
    expect(audit.at(-1)).toMatchObject({ action: 'coupon_batch_export', targetEntityId: batch.id, newValue: { codes: 4 } });
    expect((await refusal(() => service.exportCsv(actor(RESELLER), OTHER_BATCH))).reason).toBe('batch_not_found');
  });

  it('switches every live code of a batch off at once', async () => {
    const { service, db, audit } = build();
    const batch = await service.generate(actor(RESELLER), { ...BATCH, count: 3 });
    const out = await service.deactivate(actor(RESELLER), batch.id);
    expect(out).toMatchObject({ id: batch.id, deactivated: 3 });
    expect(db.coupon.rows.filter((r) => r['batchId'] === batch.id).every((r) => r['isActive'] === false)).toBe(true);
    expect(db.couponBatch.rows.find((r) => r['id'] === batch.id)?.['deactivatedAt']).toBeInstanceOf(Date);
    expect(audit.at(-1)).toMatchObject({ action: 'coupon_batch_deactivate', newValue: { deactivated: 3 } });
    expect((await refusal(() => service.deactivate(actor(RESELLER), OTHER_BATCH))).reason).toBe('batch_not_found');
  });
});
