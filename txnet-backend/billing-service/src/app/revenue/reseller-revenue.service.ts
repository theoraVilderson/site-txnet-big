import { Injectable } from '@nestjs/common';
import { LedgerDirection, PaymentStatus, Prisma, TenantBillingReasonType, TenantLedgerDirection, WalletReasonType } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  convertedByChanges,
  operatingCurrencyOf,
  tenantTransaction,
  moneyText, currencyPlacesOf, convertedText,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { FEWER_THAN, HiddenCurrency, HiddenReason, RevenueBreakdown, SplitPeople, breakdownOf, readBreakdown, readSplitPeople, suppressSplit } from './revenue-breakdown';

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

/** One currency's figure as written (2 places, the column's), before any conversion. */
export type CurrencyTotal = { currencyCode: string; total: string; count: number };

export type RevenueTotals = {
  /** The window actually totalled, as the request resolved it. */
  from: string;
  to: string;
  /**
   * The reseller's operating currency now: what every converted `total` is in
   * (F-116-h8, ADR-0098 part 3).
   */
  currencyCode: string;
  /**
   * What this reseller **sold** in the window, with the reasons that make up
   * the total. Each currency is summed on its own (`byCurrency`); a `total` is
   * those sums converted through the reseller's currency changes into
   * `currencyCode`, and `null` when no change leads from one of them — never
   * summed as written.
   */
  sales: {
    total: string | null;
    count: number;
    /** To the platform's staff a reason under 5 people, and its pair, is hidden (F-117-l). */
    byReason: ({ reasonType: WalletReasonType; total: string | null; count: number } | HiddenReason)[];
    /** To the platform's staff a currency under 5 people, and its pair, is hidden (F-117-k). */
    byCurrency: (CurrencyTotal | HiddenCurrency)[];
  };
  /** What its users **paid in** in the window. Money in, not revenue (ADR-0067). */
  topUps: { total: string | null; count: number; byCurrency: (CurrencyTotal | HiddenCurrency)[] };
  /**
   * The platform's own tenant only (UX-1-r3): what it **charged** its resellers
   * in the window — their billing ledgers' charges net of the refunds that undo
   * them, a package's period included — and what they **paid in**. Absent on a
   * reseller: its own payments to the platform are money out, not revenue.
   */
  fromResellers?: { charged: { total: string | null; count: number }; paidIn: { total: string | null; count: number } };
};

/**
 * Which wallet reasons are a sale — the arithmetic of this whole surface, in
 * one exhaustive table so a new `WalletReasonType` does not compile until
 * somebody says whether a reseller earned money by it (C-09's habit, applied to
 * a business rule rather than a schema).
 *
 * A sale is a **debit with a sale reason**, and almost nothing qualifies:
 * `traffic_consumption` and `product_purchase` are a user paying this reseller
 * for service, and that is what a reseller sells. The rest move money without anything being sold, and
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
  // A credit: money given back, not a sale. It is subtracted below rather than
  // counted here, which `UNDOES` is what says.
  [WalletReasonType.traffic_refund]: false,
  // A catalog product bought from the wallet (F-111-b): what a reseller sells,
  // paid up front rather than by the byte.
  [WalletReasonType.product_purchase]: true,
  // A credit: an undelivered purchase given back (F-111-d). Subtracted below, like `traffic_refund`.
  [WalletReasonType.product_refund]: false,
  // F-116-f: a balance restated in a new currency — a closing debit and an opening credit, nothing sold.
  [WalletReasonType.currency_change]: false,
  // F-118-g: a meter's usage paid for — a prepaid block or a postpaid capture. The sale.
  [WalletReasonType.usage_charge]: true,
  // A credit: a prepaid block's unused part given back. Subtracted below.
  [WalletReasonType.usage_refund]: false,
};

/** The reasons that count, derived from the table above rather than listed twice. */
export const SALE_REASONS = (Object.keys(IS_SALE) as WalletReasonType[]).filter((r) => IS_SALE[r]);

/**
 * Which sale a credit **undoes**, if any — the second half of `IS_SALE`, and
 * exhaustive for the same reason.
 *
 * A closed metered Grant gives its unconsumed bytes back (F-027-r, ADR-0072
 * rule 3), and that money was counted as a sale when the block was bought. A
 * figure that took the debits and ignored the credits would report every
 * reseller more revenue than it kept, by exactly the headroom this platform
 * holds ahead of consumption — and it would grow with the number of Grants that
 * expire, which is all of them.
 *
 * Only a refund that undoes a **sale** belongs here. A top-up reversed at the
 * gateway is money in, not revenue (ADR-0067), and a transfer back is neither.
 */
const UNDOES: Record<WalletReasonType, WalletReasonType | null> = {
  [WalletReasonType.traffic_refund]: WalletReasonType.traffic_consumption,
  // F-111-d: the whole `total` of an invoice whose Grant was never delivered.
  [WalletReasonType.product_refund]: WalletReasonType.product_purchase,
  // F-118-g: a closed prepaid Grant's unused block, given back.
  [WalletReasonType.usage_refund]: WalletReasonType.usage_charge,
  [WalletReasonType.payment_gateway]: null,
  [WalletReasonType.coupon_redemption]: null,
  [WalletReasonType.affiliate_commission]: null,
  [WalletReasonType.wallet_transfer_in]: null,
  [WalletReasonType.traffic_consumption]: null,
  [WalletReasonType.sub_account_charge]: null,
  [WalletReasonType.wallet_transfer_out]: null,
  [WalletReasonType.admin_manual_adjust]: null,
  [WalletReasonType.reseller_purchase]: null,
  [WalletReasonType.product_purchase]: null,
  [WalletReasonType.currency_change]: null,
  [WalletReasonType.usage_charge]: null,
};

/** The credits that come off a sale, derived from the table above. */
export const REFUND_REASONS = (Object.keys(UNDOES) as WalletReasonType[]).filter((r) => UNDOES[r] !== null);

/** The sale each of `REFUND_REASONS` undoes, position for position. */
const UNDONE_SALES = REFUND_REASONS.map((r) => UNDOES[r] as WalletReasonType);

const money = (v: Prisma.Decimal | null | undefined) => (v ? moneyText(v) : '0.00');

const ZERO = new Prisma.Decimal(0);

/**
 * What each reseller billing reason is to the platform (UX-1-r3), exhaustive so
 * a new `TenantBillingReasonType` does not compile until somebody says.
 * `charge`: the platform sold something; `undoes`: a credit giving a charge
 * back; `paidIn`: money a reseller put in; `none`: neither.
 *
 * A package's first period is paid out of a platform user's wallet
 * (`WalletReasonType.reseller_purchase`, not a user sale above), lands here as a
 * `reseller_purchase` credit and is then charged as `subscription_charge` — so
 * the charge is the sale, and counting the wallet debit too would count it twice.
 */
const RESELLER_LEDGER: Record<TenantBillingReasonType, { kind: 'charge' } | { kind: 'undoes'; charge: TenantBillingReasonType } | { kind: 'paidIn' } | { kind: 'none' }> = {
  [TenantBillingReasonType.topup_payment]: { kind: 'paidIn' },
  [TenantBillingReasonType.reseller_purchase]: { kind: 'paidIn' },
  [TenantBillingReasonType.subscription_charge]: { kind: 'charge' },
  [TenantBillingReasonType.subscription_upgrade_charge]: { kind: 'charge' },
  [TenantBillingReasonType.metered_usage_charge]: { kind: 'charge' },
  [TenantBillingReasonType.metered_usage_refund]: { kind: 'undoes', charge: TenantBillingReasonType.metered_usage_charge },
  [TenantBillingReasonType.sms_usage_charge]: { kind: 'charge' },
  [TenantBillingReasonType.quota_overage_charge]: { kind: 'charge' },
  [TenantBillingReasonType.quota_overage_refund]: { kind: 'undoes', charge: TenantBillingReasonType.quota_overage_charge },
  // An operator's correction, and a currency change's closing/opening pair: nothing sold, nothing paid.
  [TenantBillingReasonType.admin_manual_adjust]: { kind: 'none' },
  [TenantBillingReasonType.currency_change]: { kind: 'none' },
};

/** Amounts per currency, as written: the shape every figure below is summed into. */
type ByCurrency = Map<string, Prisma.Decimal>;

const add = (into: ByCurrency, code: string, amount: Prisma.Decimal) =>
  into.set(code, (into.get(code) ?? ZERO).plus(amount));

const listed = (sums: ByCurrency, counts: Map<string, number>): CurrencyTotal[] =>
  [...new Set([...sums.keys(), ...counts.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .map((currencyCode) => ({ currencyCode, total: money(sums.get(currencyCode)), count: counts.get(currencyCode) ?? 0 }));

/**
 * ADR-0104 (3): the platform's staff reading a **reseller** see a cell under 5
 * people hidden. The platform's own figures (UX-1-r2) are its own people's, so
 * nothing is hidden from its staff there.
 */
const hidesSmallCells = (admitted: AdmittedReseller) => admitted.as === 'staff' && admitted.platform !== true;

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
    /** Every reseller's billing ledger at once — read only after the door admitted the platform's staff (ADR-0053). */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /**
   * Both totals for one period. `read`, not `staffWrite`: a suspended reseller
   * may still see what it earned — the same capability the reseller surfaces
   * use for their lists.
   */
  async totals(actor: ResellerActor, tenantId: string, period: RevenuePeriod): Promise<RevenueTotals> {
    const createdAt = { gte: period.from, lte: period.to };

    return this.run(actor, tenantId, async (reseller) =>
      tenantTransaction(this.prisma, async (tx) => {
        const [sales, refunds, topUps] = await Promise.all([
          // Grouped by currency as well (F-116-h8): a sum across currencies is
          // dollars and rials added as one number, so it is never asked for.
          tx.walletTransaction.groupBy({
            by: ['reasonType', 'currencyCode'],
            where: { direction: LedgerDirection.debit, reasonType: { in: SALE_REASONS }, createdAt },
            _sum: { amount: true },
            _count: { _all: true },
          }),
          // The credits that undo one. Read in the same window as the sales: a
          // refund lands when the Grant closes, so a period can hold a close
          // whose blocks were bought before it — the figure is the movement in
          // the window, and a reason can come out negative rather than be
          // clamped to something no rows back.
          tx.walletTransaction.groupBy({
            by: ['reasonType', 'currencyCode'],
            where: { direction: LedgerDirection.credit, reasonType: { in: REFUND_REASONS }, createdAt },
            _sum: { amount: true },
          }),
          tx.paymentTransaction.groupBy({
            by: ['currencyCode'],
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

        // What came back, against the sale it came off, in the currency it was
        // written in. `count` is untouched: the blocks were sold and the rows
        // exist — what changed is how much of the money the reseller kept.
        const net = new Map<WalletReasonType, ByCurrency>();
        const counts = new Map<WalletReasonType, number>();
        const salesCounts = new Map<string, number>();
        const salesByCurrency: ByCurrency = new Map();
        const of = (reason: WalletReasonType) => net.get(reason) ?? net.set(reason, new Map()).get(reason)!;
        for (const row of sales) {
          const amount = new Prisma.Decimal(money(row._sum.amount));
          add(of(row.reasonType), row.currencyCode, amount);
          add(salesByCurrency, row.currencyCode, amount);
          counts.set(row.reasonType, (counts.get(row.reasonType) ?? 0) + row._count._all);
          salesCounts.set(row.currencyCode, (salesCounts.get(row.currencyCode) ?? 0) + row._count._all);
        }
        for (const row of refunds) {
          const sale = UNDOES[row.reasonType];
          if (!sale) continue;
          const amount = new Prisma.Decimal(money(row._sum.amount)).neg();
          add(of(sale), row.currencyCode, amount);
          add(salesByCurrency, row.currencyCode, amount);
        }

        const convert = await this.converter(tx, tenantId);

        // Every reason either list names, so a window holding a close and none
        // of the blocks it refunds still reports the money going back out.
        const byReason: RevenueTotals['sales']['byReason'] = [];
        let salesTotal: Prisma.Decimal | null = ZERO;
        for (const [reasonType, sums] of net) {
          const total = await convert.sum(sums);
          // Summed from the rows already read rather than asked for again:
          // a second aggregate is a second chance for the two to disagree.
          salesTotal = salesTotal && total ? salesTotal.plus(total) : null;
          byReason.push({ reasonType, total: convert.show(total), count: counts.get(reasonType) ?? 0 });
        }

        // ADR-0104 (3): every split below is a breakdown; the platform's staff
        // see a cell under 5 people hidden, paired (F-117-k, F-117-l). The
        // wholes — sales.total/count, topUps.total/count — are never hidden.
        const people: SplitPeople[] | null =
          hidesSmallCells(reseller) ? await readSplitPeople(tx, period, SALE_REASONS, REFUND_REASONS, UNDONE_SALES) : null;
        const currency = (c: CurrencyTotal): HiddenCurrency => ({ currencyCode: c.currencyCode, total: null, count: null, people: FEWER_THAN });
        const split = <C extends { count: number }, H>(cells: C[], keyOf: (c: C) => string, of: SplitPeople['split'], hide: (c: C) => H): (C | H)[] =>
          people ? suppressSplit(cells, keyOf, people, of, hide) : cells;

        const paidIn: ByCurrency = new Map();
        const paidInCounts = new Map<string, number>();
        for (const row of topUps) {
          add(paidIn, row.currencyCode, new Prisma.Decimal(money(row._sum.amountCredited)));
          paidInCounts.set(row.currencyCode, row._count._all);
        }

        return {
          from: period.from.toISOString(),
          to: period.to.toISOString(),
          currencyCode: convert.currencyCode,
          sales: {
            total: convert.show(salesTotal),
            count: byReason.reduce((n, row) => n + row.count, 0),
            byReason: split(byReason, (r) => r.reasonType, 'salesReason', (r): HiddenReason => ({ reasonType: r.reasonType, total: null, count: null, people: FEWER_THAN })),
            byCurrency: split(listed(salesByCurrency, salesCounts), (c) => c.currencyCode, 'salesCurrency', currency),
          },
          topUps: {
            total: convert.show(await convert.sum(paidIn)),
            count: [...paidInCounts.values()].reduce((n, c) => n + c, 0),
            byCurrency: split(listed(paidIn, paidInCounts), (c) => c.currencyCode, 'topUpCurrency', currency),
          },
          ...(reseller.platform ? { fromResellers: await this.fromResellers(period, convert) } : {}),
        };
      }),
    );
  }

  /**
   * The same sales split by product and by day, each cell with its number of
   * people (F-117-h, ADR-0104 (2)(3)). Tier A: no consent — so for the
   * platform's staff a cell under 5 people is `fewer_than_5`; the reseller's
   * own people see every cell. Days are the reseller's (`tenant.timezone`).
   */
  async breakdown(actor: ResellerActor, tenantId: string, period: RevenuePeriod): Promise<RevenueBreakdown> {
    return this.run(actor, tenantId, async (reseller) =>
      tenantTransaction(this.prisma, async (tx) => {
        const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
        const timeZone = tenant?.timezone ?? 'UTC';
        const rows = await readBreakdown(tx, period, timeZone, SALE_REASONS, REFUND_REASONS);
        const convert = await this.converter(tx, tenantId);
        return breakdownOf(rows, { staff: hidesSmallCells(reseller), convert, period, timeZone });
      }),
    );
  }

  /**
   * UX-1-r3: every reseller's billing ledger over the window, read across
   * tenants — their wallets are theirs under RLS. Each currency on its own, then
   * converted with the platform's own changes, as everything else here is.
   */
  private async fromResellers(period: RevenuePeriod, convert: { show: (v: Prisma.Decimal | null) => string | null; sum: (s: ByCurrency) => Promise<Prisma.Decimal | null> }) {
    const rows = await this.all.tenantBillingTransaction.groupBy({
      by: ['reasonType', 'direction', 'currencyCode'],
      where: { createdAt: { gte: period.from, lte: period.to } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const charged: ByCurrency = new Map();
    const paidIn: ByCurrency = new Map();
    let chargedCount = 0;
    let paidInCount = 0;
    for (const row of rows) {
      const kind = RESELLER_LEDGER[row.reasonType];
      const amount = new Prisma.Decimal(money(row._sum.amount));
      if (kind.kind === 'charge' && row.direction === TenantLedgerDirection.debit) {
        add(charged, row.currencyCode, amount);
        chargedCount += row._count._all;
      } else if (kind.kind === 'undoes' && row.direction === TenantLedgerDirection.credit) {
        add(charged, row.currencyCode, amount.neg());
      } else if (kind.kind === 'paidIn' && row.direction === TenantLedgerDirection.credit) {
        add(paidIn, row.currencyCode, amount);
        paidInCount += row._count._all;
      }
    }
    return {
      charged: { total: convert.show(await convert.sum(charged)), count: chargedCount },
      paidIn: { total: convert.show(await convert.sum(paidIn)), count: paidInCount },
    };
  }

  /**
   * Sums per currency into the reseller's currency now: an earlier one
   * converted through its `currency_change` rows, as the coupon usage report's
   * is (F-116-h5) — `null` when no change leads from it. Shown at the target
   * currency's own places; a figure with no currency to convert is zero.
   */
  private async converter(tx: Prisma.TransactionClient, tenantId: string) {
    const currencyCode = await operatingCurrencyOf(tx, tenantId);
    const places = await currencyPlacesOf(tx, currencyCode);
    return {
      currencyCode,
      show: (v: Prisma.Decimal | null) => (v ? convertedText(v, places) : null),
      sum: async (sums: ByCurrency): Promise<Prisma.Decimal | null> => {
        let total: Prisma.Decimal | null = ZERO;
        for (const [code, amount] of sums) {
          const converted = code === currencyCode ? amount : await convertedByChanges(tx, tenantId, amount, code, currencyCode);
          total = converted && total ? total.plus(converted) : null;
        }
        return total;
      },
    };
  }

  /** Admit, run in the reseller's scope, and translate the door's refusal into this surface's one type. */
  private async run<T>(actor: ResellerActor, tenantId: string, work: (reseller: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      // The platform's own tenant too, to its staff (UX-1-r2): its dashboard's revenue.
      return await this.access.for('report.read').runFiguresIncludingPlatform(actor, tenantId, 'read', (reseller) => work(reseller));
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerRevenueRefused(e.reason, tenantId);
      throw e;
    }
  }
}
