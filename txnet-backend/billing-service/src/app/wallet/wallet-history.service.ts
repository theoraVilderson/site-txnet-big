import { Injectable } from '@nestjs/common';
import { LedgerDirection, PaymentStatus, Prisma, WalletReasonType } from '@prisma/client';
import { BackendI18nKeys, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { LocaleService } from '../locale/locale.service';
import { PrismaService } from '../prisma/prisma.service';
import { foldedSearch } from './persian-search';

/**
 * What the panel's financial page reads (F-092-n): the wallet ledger as a
 * filtered page, and — separately — the top-up attempts that never became
 * ledger rows.
 *
 * **The balance is read, never rebuilt.** Legacy reconstructed each row's
 * balance by taking the wallet's current balance and walking backwards over
 * every row it had skipped, adding and subtracting amounts as it went. It
 * counted `pending` and `failed` attempts among them, so a single abandoned
 * top-up shifted the balance column of every row above it, permanently. Here
 * `balanceAfter` is the column `WalletLedgerService` wrote inside the
 * balance-changing transaction (invariant 1), and the page's `balance` is
 * `cachedBalance` — a cache only that same transaction writes, so it is the
 * ledger's own number rather than a second opinion about it.
 *
 * **A payment attempt is not a ledger row.** Legacy kept both in one Mongo
 * collection, which is why its arithmetic could count a failure as money. The
 * two are different lists here: `payments()` answers `payment_transaction`,
 * whose rows carry a `status` and no balance, and only the `success` ones have
 * a ledger row at all (F-092-j credits it).
 *
 * **The search has no free text to search.** A `wallet_transaction` is
 * `reasonType` + `referenceId`; legacy's Persian `title` column has no
 * equivalent and is not worth one, because the title it stored was derived from
 * the type in the first place. So a term is matched — folded, see
 * `persian-search.ts` — against the **translated label** of each reason type in
 * the request's language, and the types that match become the filter. A term
 * matching no label filters to nothing, which is the honest answer: it is what
 * the user asked for and found.
 */

const REASON_LABEL_KEY = BackendI18nKeys.billing.reasonType;

/** Every reason type has a label key; a new enum value does not compile until it gets one. */
const LABEL_KEYS: Record<WalletReasonType, string> = {
  [WalletReasonType.payment_gateway]: REASON_LABEL_KEY.payment_gateway,
  [WalletReasonType.coupon_redemption]: REASON_LABEL_KEY.coupon_redemption,
  [WalletReasonType.traffic_consumption]: REASON_LABEL_KEY.traffic_consumption,
  [WalletReasonType.admin_manual_adjust]: REASON_LABEL_KEY.admin_manual_adjust,
  [WalletReasonType.affiliate_commission]: REASON_LABEL_KEY.affiliate_commission,
  [WalletReasonType.sub_account_charge]: REASON_LABEL_KEY.sub_account_charge,
  [WalletReasonType.wallet_transfer_in]: REASON_LABEL_KEY.wallet_transfer_in,
  [WalletReasonType.wallet_transfer_out]: REASON_LABEL_KEY.wallet_transfer_out,
  [WalletReasonType.reseller_purchase]: REASON_LABEL_KEY.reseller_purchase,
  // A credit of its own, and **not** hidden with the debits below: money going
  // back to a user belongs on the page they read without narrowing (F-027-r).
  [WalletReasonType.traffic_refund]: REASON_LABEL_KEY.traffic_refund,
  // A product bought from the wallet (F-111-b): on the default page, like every debit but traffic.
  [WalletReasonType.product_purchase]: REASON_LABEL_KEY.product_purchase,
};

/** The declaration order, which is the order a filter is answered in. */
const REASON_TYPES = Object.keys(LABEL_KEYS) as WalletReasonType[];

/**
 * Left out of a page nobody narrowed (F-027-am, ADR-0072).
 *
 * The block purchaser debits the wallet once per block, and a block covers
 * about two minutes of that user's own spend — so a heavy user writes hundreds
 * of `traffic_consumption` rows a day, and unfiltered they bury the movements a
 * person came to this page to read. The **ledger** still carries every one of
 * them: rolling the debit up was the alternative and it is not available, since
 * the money has to move before the bytes do (ADR-0072) and `balanceAfter` is
 * the column the debiting transaction wrote (rule 1 in `contract.history.md`).
 * So the aggregation lives here, on the read side, where it costs a filter.
 *
 * It is the **default**, not a rule: any narrowing the caller asked for is
 * answered as asked — `types[]` naming traffic, or a term that matched its
 * label. Answering "no results" to a search typed right is the failure this
 * page already refuses for the Persian fold, and hiding money from someone who
 * asked for it by name would be a worse version of it.
 */
const UNNARROWED_TYPES = REASON_TYPES.filter((t) => t !== WalletReasonType.traffic_consumption);

export type LedgerPageRequest = {
  /** From the gate's `X-User-Id` — the only tenant-scoped source of a user id here. */
  userId: string;
  /** The request's resolved language; the search is matched against its labels. */
  lang: string;
  types?: readonly WalletReasonType[];
  direction?: LedgerDirection;
  from?: Date;
  to?: Date;
  search?: string;
  /** Absent is the first page — `DEFAULT_PAGE`. The schema names no default (`wallet-history.schema.ts`). */
  page?: number;
  pageSize?: number;
};

export type LedgerRow = {
  id: string;
  amount: string;
  direction: LedgerDirection;
  reasonType: WalletReasonType;
  /** The row this movement was caused by — a payment, a transfer, a commission. */
  referenceId: string | null;
  /** The balance after this row, as the ledger wrote it. Never recomputed. */
  balanceAfter: string;
  createdAt: string;
};

export type LedgerPage = {
  /** Base currency (ADR-0019), a decimal string — the wallet's balance now. */
  balance: string;
  total: number;
  page: number;
  pageSize: number;
  rows: LedgerRow[];
};

export type PaymentPageRequest = {
  userId: string;
  statuses?: readonly PaymentStatus[];
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
};

export type PaymentRow = {
  id: string;
  status: PaymentStatus;
  amountRequested: string;
  fee: string;
  /** The tax on top, and the rate it was charged at — frozen at intent (ADR-0076). `0.00` and `null` when untaxed. */
  tax: string;
  taxRatePercent: string | null;
  discount: string;
  amountCredited: string;
  /** What the gateway was asked for, and the rate that produced it — frozen at intent (ADR-0019). */
  charge: { amountMinor: string; rate: string | null };
  /** Zarinpal's `authority`; the id a duplicate callback shares (ADR-0028). */
  trackingCode: string | null;
  /** The receipt number of a paid payment — what the user quotes to support. */
  referenceId: string | null;
  cardPanMasked: string | null;
  failureCode: string | null;
  gateway: { source: 'platform' | 'tenant'; id: string; displayName: string } | null;
  createdAt: string;
  expiresAt: string | null;
  /**
   * `pending` with its retry clock running (F-092-x): the gateway met the
   * verify with silence and is being asked again. The money may have moved.
   */
  verifying: boolean;
};

export type PaymentPage = {
  total: number;
  page: number;
  pageSize: number;
  rows: PaymentRow[];
};

const money = (v: Prisma.Decimal) => v.toFixed(2);

/** `undefined` rather than an empty object: an empty `createdAt` filter is a Prisma error, not a no-op. */
function between(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
}

/**
 * The columns a history row needs. Explicit, like the deposit routes' — a
 * `payment_transaction` sits next to gateway rows that hold secrets
 * (invariant 8), and `select` is what keeps a later schema addition out of a
 * response nobody re-read.
 */
const PAYMENT_COLUMNS = {
  id: true,
  status: true,
  amountRequested: true,
  feeApplied: true,
  taxApplied: true,
  taxRatePercent: true,
  discountApplied: true,
  amountCredited: true,
  chargedAmountMinor: true,
  exchangeRateSnapshot: true,
  gatewayTrackingCode: true,
  gatewayReferenceId: true,
  cardPanMasked: true,
  failureCode: true,
  createdAt: true,
  expiresAt: true,
  nextVerifyAt: true,
  gateway: { select: { id: true, displayName: true } },
  tenantGatewayConfig: { select: { id: true, displayName: true } },
} satisfies Prisma.PaymentTransactionSelect;

/**
 * What an absent page means. Here and nowhere else — both routes resolve it
 * through `paged()`, so the two lists cannot drift apart, and neither can this
 * and a second copy in the schema. `pageSize` is bounded at 100 by the schema
 * when it is sent; this is only what to use when it was not.
 */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;

const paged = (request: { page?: number; pageSize?: number }) => ({
  page: request.page ?? DEFAULT_PAGE,
  pageSize: request.pageSize ?? DEFAULT_PAGE_SIZE,
});

type PaymentColumns = Prisma.PaymentTransactionGetPayload<{ select: typeof PAYMENT_COLUMNS }>;

/** One attempt as both routes answer it. */
function paymentRowOf(r: PaymentColumns): PaymentRow {
  return {
    id: r.id,
    status: r.status,
    amountRequested: money(r.amountRequested),
    fee: money(r.feeApplied),
    tax: money(r.taxApplied),
    taxRatePercent: r.taxRatePercent?.toFixed() ?? null,
    discount: money(r.discountApplied),
    amountCredited: money(r.amountCredited),
    charge: {
      amountMinor: r.chargedAmountMinor.toString(),
      rate: r.exchangeRateSnapshot === null ? null : r.exchangeRateSnapshot.toString(),
    },
    trackingCode: r.gatewayTrackingCode,
    referenceId: r.gatewayReferenceId,
    cardPanMasked: r.cardPanMasked,
    failureCode: r.failureCode,
    // Exactly one of the two columns is set — a CHECK enforces it
    // (ADR-0006, F-092-d) — and the answer names which, as the deposit
    // routes do, since the ids never cross tables.
    gateway: r.gateway
      ? { source: 'platform' as const, id: r.gateway.id, displayName: r.gateway.displayName }
      : r.tenantGatewayConfig
        ? { source: 'tenant' as const, id: r.tenantGatewayConfig.id, displayName: r.tenantGatewayConfig.displayName }
        : null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    verifying: r.status === PaymentStatus.pending && r.nextVerifyAt !== null,
  };
}

@Injectable()
export class WalletHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locale: LocaleService,
  ) {}

  async ledger(request: LedgerPageRequest): Promise<LedgerPage> {
    TenantContext.current('wallet history');
    const { userId } = request;
    const { page, pageSize } = paged(request);

    const reasonType = this.reasonFilter(request);
    const empty = (balance: string): LedgerPage => ({ balance, total: 0, page, pageSize, rows: [] });

    return tenantTransaction(this.prisma, async (tx) => {
      // `wallet` carries no `tenantId` and is reached through its owner, so the
      // scope is the gate's `X-User-Id` (ledger rule 2 in `contract.md`).
      const wallet = await tx.wallet.findUnique({
        where: { ownerUserId: userId },
        select: { id: true, cachedBalance: true },
      });
      // No wallet is a zero balance, as it is for a debit — not a 404. The page
      // exists before the first top-up does.
      if (!wallet) return empty('0.00');
      const balance = money(wallet.cachedBalance);
      // A search that matched no label. Answered here rather than as
      // `reasonType: { in: [] }`, so the filter cannot be dropped on the way to
      // the query and answer the whole ledger instead of none of it.
      if (reasonType.in.length === 0) return empty(balance);

      const where: Prisma.WalletTransactionWhereInput = {
        walletId: wallet.id,
        reasonType,
        ...(request.direction ? { direction: request.direction } : {}),
        ...(between(request.from, request.to) ? { createdAt: between(request.from, request.to) } : {}),
      };

      const [rows, total] = await Promise.all([
        tx.walletTransaction.findMany({
          where,
          // `id` breaks the tie: two rows of one transaction share a timestamp,
          // and an unstable order repeats or skips one across pages.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            amount: true,
            direction: true,
            reasonType: true,
            referenceId: true,
            balanceAfter: true,
            createdAt: true,
          },
        }),
        tx.walletTransaction.count({ where }),
      ]);

      return {
        balance,
        total,
        page,
        pageSize,
        rows: rows.map((r) => ({
          id: r.id,
          amount: money(r.amount),
          direction: r.direction,
          reasonType: r.reasonType,
          referenceId: r.referenceId,
          balanceAfter: money(r.balanceAfter),
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });
  }

  /**
   * The top-up attempts, the list the ledger deliberately does not carry: a
   * `pending` or `failed` payment moved no money, so it has no balance and
   * belongs to no ledger page.
   */
  async payments(request: PaymentPageRequest): Promise<PaymentPage> {
    TenantContext.current('wallet payments');
    const { userId } = request;
    const { page, pageSize } = paged(request);

    const where: Prisma.PaymentTransactionWhereInput = {
      userId,
      ...(request.statuses?.length ? { status: { in: [...request.statuses] } } : {}),
      ...(between(request.from, request.to) ? { createdAt: between(request.from, request.to) } : {}),
    };

    return tenantTransaction(this.prisma, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.paymentTransaction.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: PAYMENT_COLUMNS,
        }),
        tx.paymentTransaction.count({ where }),
      ]);

      return { total, page, pageSize, rows: rows.map(paymentRowOf) };
    });
  }

  /**
   * One of the caller's own payments, or `null` (F-093-l): what the pending
   * page polls. By id **and** user, so another user's payment id answers
   * exactly what a made-up one does.
   */
  async payment(userId: string, id: string): Promise<PaymentRow | null> {
    TenantContext.current('wallet payment');
    const row = await tenantTransaction(this.prisma, (tx) =>
      tx.paymentTransaction.findFirst({ where: { id, userId }, select: PAYMENT_COLUMNS }),
    );
    return row ? paymentRowOf(row) : null;
  }

  /**
   * The `reasonType` filter. Always a filter — a page nobody narrowed is
   * `UNNARROWED_TYPES`, not the whole enum (F-027-am).
   *
   * A search term narrows to the types whose translated label matches it; an
   * explicit `types` list narrows further, so the two **intersect** — asking for
   * transfers and typing "transfer" must not widen the page back to everything.
   * Either of them is the caller naming what they want, so either one also
   * lifts the default exclusion; a blank term narrows nothing and does not.
   */
  private reasonFilter(request: LedgerPageRequest): { in: WalletReasonType[] } {
    const { search, types, lang } = request;
    const searched = search === undefined ? null : this.reasonTypesMatching(search, lang);
    if (searched === null) return { in: types?.length ? [...types] : [...UNNARROWED_TYPES] };
    return { in: types?.length ? searched.filter((t) => types.includes(t)) : searched };
  }

  /** The types whose label, in this language, contains the folded term. `null` when the term is blank. */
  private reasonTypesMatching(search: string, lang: string): WalletReasonType[] | null {
    const pattern = foldedSearch(search);
    if (pattern === null) return null;
    return REASON_TYPES.filter((type) => {
      const label = this.labelOf(type, lang);
      return label !== undefined && pattern.test(label);
    });
  }

  /**
   * A reason type's label. Falls back to the default language: a language whose
   * `billing` namespace has not been translated yet must still be searchable,
   * and answering nothing would silently empty the page instead.
   */
  private labelOf(type: WalletReasonType, lang: string): string | undefined {
    const key = LABEL_KEYS[type];
    return this.locale.getKey(lang, 'billing', key) ?? this.locale.getKey(this.locale.getDefaultLanguage(), 'billing', key);
  }
}
