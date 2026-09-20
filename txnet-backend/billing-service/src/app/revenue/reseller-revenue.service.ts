import { Injectable } from '@nestjs/common';
import { LedgerDirection, PaymentStatus, Prisma, WalletReasonType } from '@prisma/client';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/** Only one door closes here, so the refusal carries only its reasons. */
export type ResellerRevenueRejection = ResellerAccessRejection;

export class ResellerRevenueRefused extends Error {
  constructor(
    readonly reason: ResellerRevenueRejection,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ResellerRevenueRefused';
  }
}

export type RevenuePeriod = { from: Date; to: Date };

export type RevenueTotals = {
  /** The window actually totalled, as the request resolved it. */
  from: string;
  to: string;
  /**
   * What this reseller **sold** in the window: base-currency decimal strings
   * (C-02, ADR-0019), with the reasons that make up the total.
   */
  sales: {
    total: string;
    count: number;
    byReason: { reasonType: WalletReasonType; total: string; count: number }[];
  };
  /** What its users **paid in** in the window. Money in, not revenue (ADR-0067). */
  topUps: { total: string; count: number };
};

/**
 * Which wallet reasons are a sale — the arithmetic of this whole surface, in
 * one exhaustive table so a new `WalletReasonType` does not compile until
 * somebody says whether a reseller earned money by it (C-09's habit, applied to
 * a business rule rather than a schema).
 *
 * A sale is a **debit with a sale reason**, and almost nothing qualifies:
 * `traffic_consumption` is a user paying this reseller for service, and that is
 * what a reseller sells. The rest move money without anything being sold, and
 * each would inflate the figure in a different direction.
 */
const IS_SALE: Record<WalletReasonType, boolean> = {
  // Credits — money arriving in a user's wallet. A top-up is answered
  // separately and a gift is the reseller giving money away, not taking it.
  [WalletReasonType.payment_gateway]: false,
  [WalletReasonType.coupon_redemption]: false,
  [WalletReasonType.affiliate_commission]: false,
  [WalletReasonType.wallet_transfer_in]: false,
  // The sale.
  [WalletReasonType.traffic_consumption]: true,
  // A debit that funds a Config-scoped shared wallet; the consumption charged
  // out of it is the `traffic_consumption` above, so counting both would count
  // the same sale twice.
  [WalletReasonType.sub_account_charge]: false,
  // Money moved between two of this reseller's users. Nothing was sold, and
  // counting it would let a pair of accounts manufacture revenue in a loop.
  [WalletReasonType.wallet_transfer_out]: false,
  // An operator's correction. It is how a mistake is undone, not a sale.
  [WalletReasonType.admin_manual_adjust]: false,
  // The **platform's** revenue from selling a reseller package (F-019-h), paid
  // by a buyer out of a wallet in the platform owner's own tenant.
  [WalletReasonType.reseller_purchase]: false,
};

/** The reasons that count, derived from the table above rather than listed twice. */
export const SALE_REASONS = (Object.keys(IS_SALE) as WalletReasonType[]).filter((r) => IS_SALE[r]);

const money = (v: Prisma.Decimal | null | undefined) => (v ? v.toFixed(2) : '0.00');

/**
 * A reseller's own revenue (F-311-b, spec F-311, ADR-0067):
 * `GET /api/billing/tenants/:tenantId/revenue` — totals over a period for the
 * reseller the **path** names. The data half of the bot's revenue figure
 * (F-311-c), built here once so a future panel page shares it, the way
 * F-066-w3 serves F-066-w4.
 *
 * **It is not `settlement`.** `/api/billing/admin/settlement/*` (F-096-e)
 * answers the *platform owner* what a tenant owes it for a borrowed gateway.
 * That is a different number with a different audience, and ADR-0067 is why the
 * two are not one surface.
 *
 * **Two figures, and neither is the other** (ADR-0067 decision 1). `sales` is
 * what this reseller's users spent on its services; `topUps` is what they paid
 * in. A user who tops up 100 and spends 40 is 40 of revenue and 100 of money
 * in, and a single "revenue" number would have to be one of them wearing the
 * other's name.
 *
 * **Gross** (ADR-0067 decision 2). What the platform charges this reseller
 * lives in `tenant_billing_transaction`, a different ledger on a different
 * period, so a net figure computed here would be a subtraction no row backs.
 *
 * **The scope is the whole filter.** `ResellerAccess.run` opens the admitted
 * reseller's tenant, and both tables read here are strict under RLS *and*
 * registered in `TENANT_SCOPED_MODELS` — so no query below names a `tenantId`.
 * A filter written by hand is a filter that can be written wrong, and the
 * mistake this surface exists to prevent is one reseller reading another's
 * takings.
 */
@Injectable()
export class ResellerRevenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  /**
   * Both totals for one period. `read`, not `staffWrite`: a suspended reseller
   * may still see what it earned — the same capability the reseller surfaces
   * use for their lists.
   */
  async totals(actor: ResellerActor, tenantId: string, period: RevenuePeriod): Promise<RevenueTotals> {
    const createdAt = { gte: period.from, lte: period.to };

    return this.run(actor, tenantId, async () =>
      tenantTransaction(this.prisma, async (tx) => {
        const [sales, topUps] = await Promise.all([
          tx.walletTransaction.groupBy({
            by: ['reasonType'],
            where: { direction: LedgerDirection.debit, reasonType: { in: SALE_REASONS }, createdAt },
            _sum: { amount: true },
            _count: { _all: true },
          }),
          tx.paymentTransaction.aggregate({
            // Only a settled payment is money: legacy counted `pending` and
            // `failed` attempts and got a balance that drifted for ever
            // (`contract.history.md`). `billingTenantId: null` leaves out the
            // reseller's own top-up of its platform billing wallet (F-019-b) —
            // money it paid out, which its scope would not hold anyway.
            where: { status: PaymentStatus.success, billingTenantId: null, createdAt },
            _sum: { amountCredited: true },
            _count: { _all: true },
          }),
        ]);

        const byReason = sales.map((row) => ({
          reasonType: row.reasonType,
          total: money(row._sum.amount),
          count: row._count._all,
        }));

        return {
          from: period.from.toISOString(),
          to: period.to.toISOString(),
          sales: {
            // Summed from the rows already read rather than asked for again:
            // a second aggregate is a second chance for the two to disagree.
            total: byReason
              .reduce((sum, row) => sum.plus(row.total), new Prisma.Decimal(0))
              .toFixed(2),
            count: byReason.reduce((n, row) => n + row.count, 0),
            byReason,
          },
          topUps: { total: money(topUps._sum.amountCredited), count: topUps._count._all },
        };
      }),
    );
  }

  /** Admit, run in the reseller's scope, and translate the door's refusal into this surface's one type. */
  private async run<T>(actor: ResellerActor, tenantId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, 'read', () => work());
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerRevenueRefused(e.reason, tenantId);
      throw e;
    }
  }
}
