/**
 * A variant's sales counts (F-513-b, catalog F-513): what moves them, what is
 * refused when none is left, and who is told.
 *
 * What would break silently here, and nowhere else:
 *  - a hold or a free path taking the last unit twice — the function refuses
 *    with `sold_out`, and the caller must turn that into a refusal, never a
 *    sale past the cap;
 *  - an admin's or a reseller's issue refused by a full cap — it counts and is
 *    never refused (user, 2026-10-18);
 *  - a page left stale: a capped variant's move writes one event on its
 *    owner's catalog channel — `platform` for the platform's, which every
 *    reseller's shop hears, however many there are (RT-1-p);
 *  - a socket push on every sale of an uncapped variant, which shows nothing;
 *  - a hold on a variant capped only by its live services left unannounced:
 *    the hold takes a slot there too (F-514-b), so the shop's `remaining` moved.
 */
import { GrantSource } from '@prisma/client';
import { OutboxEventType, PLATFORM_CATALOG_ID, runWithTenant } from '@txnet-backend/shared-core';
import { describe, expect, it, vi } from 'vitest';

import { countSaleOf, moveSales, SALE_COUNTING, VARIANT_SALES_AGGREGATE, VariantSoldOut } from './sales-counts';

const RESELLER = '11111111-1111-4111-8111-111111111111';
const PLATFORM = '22222222-2222-4222-8222-222222222222';
const VARIANT = '55555555-5555-4555-8555-555555555555';

type Row = {
  outcome: string;
  tenantId: string | null;
  salesCap: number | null;
  activeCap: number | null;
  soldCount: number | null;
  reservedCount: number | null;
};

function fakeTx(row: Row) {
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push({ text: strings.join('?'), values });
      return [row];
    }),
    outboxEvent: { create: vi.fn(async () => ({ id: 'e' })) },
    tenant: { findFirst: vi.fn(async () => ({ id: PLATFORM })) },
  };
  return { tx, sql };
}

const asTenant = <T>(fn: () => Promise<T>, id = RESELLER) => runWithTenant({ id }, fn);
const moved = (o: Partial<Row> = {}): Row => ({ outcome: 'moved', tenantId: RESELLER, salesCap: 10, activeCap: null, soldCount: 3, reservedCount: 1, ...o });

describe('moveSales (F-513-b)', () => {
  it('a hold takes a unit and is refused when none is left', async () => {
    const { tx, sql } = fakeTx({ outcome: 'sold_out', tenantId: RESELLER, salesCap: 2, activeCap: null, soldCount: 1, reservedCount: 1 });
    await expect(asTenant(() => moveSales(tx as never, VARIANT, 'reserve'))).rejects.toBeInstanceOf(VariantSoldOut);
    // sold 0, held +1, refused when full
    expect(sql[0].values).toEqual([VARIANT, 0, 1, true]);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('a hold becoming a sale, a release and a refund are never refused', async () => {
    for (const [move, values] of [
      ['sellReserved', [VARIANT, 1, -1, false]],
      ['release', [VARIANT, 0, -1, false]],
      ['unsell', [VARIANT, -1, 0, false]],
      ['count', [VARIANT, 1, 0, false]],
    ] as const) {
      const { tx, sql } = fakeTx(moved());
      await asTenant(() => moveSales(tx as never, VARIANT, move));
      expect(sql[0].values).toEqual(values);
    }
  });

  const eventsOf = (tx: ReturnType<typeof fakeTx>['tx']) => tx.outboxEvent.create.mock.calls.map((c: unknown[]) => (c[0] as { data: unknown }).data);
  const sales = (catalogId: string, tenantId: string) => ({
    aggregate: VARIANT_SALES_AGGREGATE,
    aggregateId: VARIANT,
    type: OutboxEventType.CATALOG_VARIANT_SALES_CHANGED,
    payload: { catalogId, tenantId, variantId: VARIANT },
  });

  it("a platform variant's move is one event on the platform's catalog, whoever sold it (RT-1-p)", async () => {
    const { tx } = fakeTx(moved({ tenantId: PLATFORM }));
    await asTenant(() => moveSales(tx as never, VARIANT, 'reserve'));
    expect(eventsOf(tx)).toEqual([sales(PLATFORM_CATALOG_ID, PLATFORM)]);
  });

  it("a reseller's own variant's move is one event on that reseller's catalog", async () => {
    const { tx } = fakeTx(moved({ tenantId: RESELLER }));
    await asTenant(() => moveSales(tx as never, VARIANT, 'release'));
    expect(eventsOf(tx)).toEqual([sales(RESELLER, RESELLER)]);
  });

  it('a variant capped only by its live services announces the hold: it took a slot (F-514-b)', async () => {
    const { tx } = fakeTx(moved({ salesCap: null, activeCap: 3 }));
    await asTenant(() => moveSales(tx as never, VARIANT, 'reserve'));
    expect(eventsOf(tx)).toEqual([sales(RESELLER, RESELLER)]);
  });

  it('a full active cap refuses the hold as a full sales cap does (F-514-b)', async () => {
    const { tx } = fakeTx({ outcome: 'sold_out', tenantId: RESELLER, salesCap: null, activeCap: 1, soldCount: 4, reservedCount: 0 });
    await expect(asTenant(() => moveSales(tx as never, VARIANT, 'reserve'))).rejects.toBeInstanceOf(VariantSoldOut);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('a variant with no cap moves its counts and pushes nothing — no page shows them as left', async () => {
    const { tx } = fakeTx(moved({ salesCap: null }));
    await asTenant(() => moveSales(tx as never, VARIANT, 'reserve'));
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('a variant the tenant cannot see is a bug in the caller, never a silent no-op', async () => {
    const { tx } = fakeTx({ outcome: 'not_found', tenantId: null, salesCap: null, activeCap: null, soldCount: null, reservedCount: null });
    await expect(asTenant(() => moveSales(tx as never, VARIANT, 'release'))).rejects.toThrow(/not_found/);
  });
});

describe('how each source meets the cap (user, 2026-10-18)', () => {
  it('automatic free paths are refused, staff issue only counts, a purchase is its invoice’s', () => {
    expect(SALE_COUNTING[GrantSource.coupon]).toBe('sell');
    expect(SALE_COUNTING[GrantSource.engagement_reward]).toBe('sell');
    expect(SALE_COUNTING[GrantSource.trial]).toBe('sell');
    expect(SALE_COUNTING[GrantSource.affiliate_reward]).toBe('sell');
    expect(SALE_COUNTING[GrantSource.admin_grant]).toBe('count');
    expect(SALE_COUNTING[GrantSource.purchase]).toBeNull();
    expect(SALE_COUNTING[GrantSource.migration]).toBeNull();
    expect(SALE_COUNTING[GrantSource.rollover]).toBeNull();
  });

  it('countSaleOf moves a free path’s unit, and a sold-out one refuses the issue', async () => {
    const { tx, sql } = fakeTx({ outcome: 'sold_out', tenantId: RESELLER, salesCap: 1, activeCap: null, soldCount: 1, reservedCount: 0 });
    await expect(asTenant(() => countSaleOf(tx as never, VARIANT, GrantSource.coupon))).rejects.toBeInstanceOf(VariantSoldOut);
    expect(sql[0].values).toEqual([VARIANT, 1, 0, true]);
  });

  it('countSaleOf of a purchase writes nothing: the invoice already holds its unit', async () => {
    const { tx } = fakeTx(moved());
    await asTenant(() => countSaleOf(tx as never, VARIANT, GrantSource.purchase));
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
