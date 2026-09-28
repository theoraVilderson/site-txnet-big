import { Injectable } from '@nestjs/common';
import { Prisma, RedemptionStatus } from '@prisma/client';
import { convertedByChanges, operatingCurrencyOf } from '@txnet-backend/shared-core';

import { CouponActor, CouponAdminService } from './coupon-admin.service';
import { CouponBatchService } from './coupon-batch.service';

export type UsageFilter = {
  status?: RedemptionStatus;
  /** Inclusive bounds on `redeemedAt`. */
  from?: string | Date;
  to?: string | Date;
  page?: number;
  pageSize?: number;
};

export type UsageItem = {
  id: string;
  couponId: string;
  code: string;
  userId: string;
  /** The account's name, for the admin who manages it; `null` when the account is gone. */
  userName: string | null;
  username: string | null;
  paymentTransactionId: string | null;
  paymentStatus: string | null;
  discountAmount: string;
  /** What `discountAmount` is in: the order's currency when it was taken (F-116-h5). */
  currencyCode: string;
  status: string;
  redeemedAt: Date;
};

export type UsageTotals = {
  /** Every redemption row in range, whatever its state. */
  redemptions: number;
  /** `confirmed` rows: uses that stuck. */
  used: number;
  /** `pending` rows: holds a payment may still turn into a use. */
  reserved: number;
  /** `expired` + `cancelled`: holds that gave their slot back. */
  released: number;
  /**
   * Sum of confirmed discounts in `currencyCode`: each currency's sum, one
   * written before a currency change converted through the tenant's changes
   * (F-116-h5). `null` when no change leads from one of them — never summed as
   * written; `discountGivenByCurrency` still says what was given.
   */
  discountGiven: string | null;
  /** The coupon owner's operating currency now. */
  currencyCode: string;
  /** Confirmed discounts per currency, as written (2 places, the column's). */
  discountGivenByCurrency: Array<{ currencyCode: string; amount: string }>;
};

export type UsageReport = { items: UsageItem[]; total: number; page: number; pageSize: number; totals: UsageTotals };

type Row = Record<string, unknown>;

/**
 * Coupon and batch usage (F-502-e, D-33). Reach is `CouponAdminService`'s and
 * `CouponBatchService`'s; a soft-deleted coupon still reports, because keeping
 * its receipts explicable is why it was not deleted (ADR-0048 decision 6).
 *
 * Totals are over the filtered range but ignore the status filter and the page:
 * they answer "what did this coupon give", which a page of one status cannot.
 */
@Injectable()
export class CouponUsageService {
  constructor(
    private readonly coupons: CouponAdminService,
    private readonly batches: CouponBatchService,
  ) {}

  async forCoupon(actor: CouponActor, couponId: string, filter: UsageFilter): Promise<UsageReport> {
    const { owner } = await this.coupons.access(actor);
    return this.coupons.within(owner, async (db) => {
      const row = await this.coupons.loadManaged(db, actor, couponId, owner, { includeDeleted: true });
      const tenantId = (row['tenantId'] as string | null) ?? actor.tenantId;
      return this.report(db, tenantId, new Map([[couponId, row['code'] as string]]), filter);
    });
  }

  async forBatch(actor: CouponActor, batchId: string, filter: UsageFilter): Promise<UsageReport> {
    const { owner } = await this.coupons.access(actor);
    return this.coupons.within(owner, async (db) => {
      const batch = await this.batches.load(db, actor, batchId, owner);
      const tenantId = (batch['tenantId'] as string | null) ?? actor.tenantId;
      const codes = await db.coupon.findMany({ where: { batchId }, select: { id: true, code: true } });
      return this.report(db, tenantId, new Map(codes.map((c) => [c.id, c.code])), filter);
    });
  }

  /** `tenantId` owns the coupons: the platform owner's for a platform coupon (`tenantId` null). */
  private async report(db: Prisma.TransactionClient, tenantId: string, codes: Map<string, string>, filter: UsageFilter): Promise<UsageReport> {
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize ?? 20)));
    const range: Prisma.CouponRedemptionWhereInput = { couponId: { in: [...codes.keys()] } };
    if (filter.from || filter.to) {
      range.redeemedAt = { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lte: new Date(filter.to) } : {}) };
    }
    const where: Prisma.CouponRedemptionWhereInput = filter.status ? { ...range, status: filter.status } : range;

    const [rows, total, groups] = await Promise.all([
      db.couponRedemption.findMany({ where, orderBy: { redeemedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      db.couponRedemption.count({ where }),
      db.couponRedemption.groupBy({ by: ['status', 'currencyCode'], where: range, _count: { _all: true }, _sum: { discountAppliedAmount: true } }),
    ]);

    const list = rows as unknown as Row[];
    const userIds = [...new Set(list.map((r) => r['userId'] as string))];
    const paymentIds = [...new Set(list.map((r) => r['paymentTransactionId'] as string | null).filter((x): x is string => !!x))];
    const [users, payments] = await Promise.all([
      userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, username: true } }) : [],
      paymentIds.length ? db.paymentTransaction.findMany({ where: { id: { in: paymentIds } }, select: { id: true, status: true } }) : [],
    ]);

    const items = list.map((r): UsageItem => {
      const user = users.find((u) => u.id === r['userId']);
      const payment = payments.find((p) => p.id === r['paymentTransactionId']);
      return {
        id: r['id'] as string,
        couponId: r['couponId'] as string,
        code: codes.get(r['couponId'] as string) ?? '',
        userId: r['userId'] as string,
        userName: user?.fullName ?? null,
        username: user?.username ?? null,
        paymentTransactionId: (r['paymentTransactionId'] as string | null) ?? null,
        paymentStatus: payment?.status ?? null,
        discountAmount: new Prisma.Decimal(String(r['discountAppliedAmount'])).toFixed(2),
        currencyCode: r['currencyCode'] as string,
        status: r['status'] as string,
        redeemedAt: r['redeemedAt'] as Date,
      };
    });

    const counts = { redemptions: 0, used: 0, reserved: 0, released: 0 };
    const given = new Map<string, Prisma.Decimal>();
    for (const g of groups) {
      const n = g._count._all;
      counts.redemptions += n;
      if (g.status === RedemptionStatus.confirmed) {
        counts.used += n;
        const sum = new Prisma.Decimal(String(g._sum.discountAppliedAmount ?? 0));
        given.set(g.currencyCode, (given.get(g.currencyCode) ?? new Prisma.Decimal(0)).plus(sum));
      } else if (g.status === RedemptionStatus.pending) counts.reserved += n;
      else counts.released += n;
    }
    return { items, total, page, pageSize, totals: { ...counts, ...(await this.given(db, tenantId, given)) } };
  }

  /**
   * Each currency's sum, then their total in the tenant's currency now: a sum
   * in an earlier one is converted through its `currency_change` rows, as
   * settlement's owed sum is (F-116-f). Added as written, a tenant that moved
   * USD -> IRR would report dollars and rials as one number.
   */
  private async given(
    db: Prisma.TransactionClient,
    tenantId: string,
    sums: Map<string, Prisma.Decimal>,
  ): Promise<Pick<UsageTotals, 'discountGiven' | 'currencyCode' | 'discountGivenByCurrency'>> {
    const currencyCode = await operatingCurrencyOf(db, tenantId);
    const target = await db.currency.findUnique({ where: { code: currencyCode }, select: { decimalPlaces: true } });
    const places = target?.decimalPlaces ?? 2;
    let total: Prisma.Decimal | null = new Prisma.Decimal(0);
    for (const [code, sum] of sums) {
      const converted = code === currencyCode ? sum : await convertedByChanges(db, tenantId, sum, code, currencyCode);
      total = converted && total ? total.plus(converted) : null;
    }
    const discountGivenByCurrency = [...sums.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, amount]) => ({ currencyCode: code, amount: amount.toFixed(2) }));
    return { discountGiven: total ? total.toFixed(places) : null, currencyCode, discountGivenByCurrency };
  }
}
