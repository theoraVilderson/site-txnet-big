import { Injectable } from '@nestjs/common';
import { Prisma, RedemptionStatus } from '@prisma/client';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
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
  /** Sum of confirmed discounts, base currency (C-02). */
  discountGiven: string;
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
    private readonly all: CrossTenantPrismaService,
  ) {}

  async forCoupon(actor: CouponActor, couponId: string, filter: UsageFilter): Promise<UsageReport> {
    const { owner } = await this.coupons.access(actor);
    const row = await this.coupons.loadManaged(actor, couponId, owner, { includeDeleted: true });
    return this.report(new Map([[couponId, row['code'] as string]]), filter);
  }

  async forBatch(actor: CouponActor, batchId: string, filter: UsageFilter): Promise<UsageReport> {
    await this.batches.load(actor, batchId);
    const codes = await this.all.coupon.findMany({ where: { batchId }, select: { id: true, code: true } });
    return this.report(new Map(codes.map((c) => [c.id, c.code])), filter);
  }

  private async report(codes: Map<string, string>, filter: UsageFilter): Promise<UsageReport> {
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize ?? 20)));
    const range: Prisma.CouponRedemptionWhereInput = { couponId: { in: [...codes.keys()] } };
    if (filter.from || filter.to) {
      range.redeemedAt = { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lte: new Date(filter.to) } : {}) };
    }
    const where: Prisma.CouponRedemptionWhereInput = filter.status ? { ...range, status: filter.status } : range;

    const [rows, total, groups] = await Promise.all([
      this.all.couponRedemption.findMany({ where, orderBy: { redeemedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.all.couponRedemption.count({ where }),
      this.all.couponRedemption.groupBy({ by: ['status'], where: range, _count: { _all: true }, _sum: { discountAppliedAmount: true } }),
    ]);

    const list = rows as unknown as Row[];
    const userIds = [...new Set(list.map((r) => r['userId'] as string))];
    const paymentIds = [...new Set(list.map((r) => r['paymentTransactionId'] as string | null).filter((x): x is string => !!x))];
    const [users, payments] = await Promise.all([
      userIds.length ? this.all.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, username: true } }) : [],
      paymentIds.length ? this.all.paymentTransaction.findMany({ where: { id: { in: paymentIds } }, select: { id: true, status: true } }) : [],
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
        status: r['status'] as string,
        redeemedAt: r['redeemedAt'] as Date,
      };
    });

    const totals: UsageTotals = { redemptions: 0, used: 0, reserved: 0, released: 0, discountGiven: '0.00' };
    for (const g of groups) {
      const n = g._count._all;
      totals.redemptions += n;
      if (g.status === RedemptionStatus.confirmed) {
        totals.used += n;
        totals.discountGiven = new Prisma.Decimal(String(g._sum.discountAppliedAmount ?? 0)).toFixed(2);
      } else if (g.status === RedemptionStatus.pending) totals.reserved += n;
      else totals.released += n;
    }
    return { items, total, page, pageSize, totals };
  }
}
