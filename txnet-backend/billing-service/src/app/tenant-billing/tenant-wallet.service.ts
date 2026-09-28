import { Injectable } from '@nestjs/common';
import { Prisma, TenantBillingReasonType, TenantLedgerDirection } from '@prisma/client';
import { platformCurrencyOf, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { TopupActor, admitResellerBilling } from './tenant-topup.service';

/**
 * A reseller reads its own billing wallet with the platform (F-019-d, D-41):
 * the balance and its movements, for the panel's billing page.
 *
 * **Its own scope, on the app pool.** The wallet is read in the reseller's
 * scope, where strict RLS on `tenant_billing_wallet` stands behind the
 * `tenantId`; the transactions are reached through that wallet's id. Never the
 * cross-tenant pool — there a wrong id is another reseller's balance.
 *
 * **The balance is the wallet's.** `cachedBalance` as the ledger wrote it
 * (invariant 3), never a sum of the rows on the page.
 *
 * The door is the top-up's: the reseller's owner, or its staff holding
 * `tenant_billing.topup`.
 */

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

export type TenantWalletQuery = { page?: number; pageSize?: number };

export type TenantWalletRow = {
  id: string;
  direction: TenantLedgerDirection;
  reasonType: TenantBillingReasonType;
  /** The platform's currency (C-02, ADR-0098 part 4), two decimals, as a string. */
  amount: string;
  balanceAfter: string;
  /** What `amount` and `balanceAfter` are in: the row's own, the platform's when it was written (F-116-h2). */
  currencyCode: string;
  createdAt: Date;
};

export type TenantWalletPage = {
  balance: string;
  /** The wallet's currency — the platform's — or the platform's now for a reseller with no wallet yet (F-116-h2). */
  currencyCode: string;
  total: number;
  page: number;
  pageSize: number;
  rows: TenantWalletRow[];
};

const money = (v: Prisma.Decimal) => v.toFixed(2);

@Injectable()
export class TenantWalletService {
  constructor(private readonly prisma: PrismaService) {}

  async history(actor: TopupActor, query: TenantWalletQuery): Promise<TenantWalletPage> {
    await admitResellerBilling(this.prisma, actor);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return tenantTransaction(this.prisma, async (tx) => {
      const wallet = await tx.tenantBillingWallet.findUnique({
        where: { tenantId: actor.tenantId },
        select: { id: true, cachedBalance: true, currencyCode: true },
      });
      // A reseller that never topped up has no wallet yet: a zero balance, as the ledger reads it.
      if (!wallet) return { balance: '0.00', currencyCode: await platformCurrencyOf(tx), total: 0, page, pageSize, rows: [] };

      const where = { walletId: wallet.id };
      const [rows, total] = await Promise.all([
        tx.tenantBillingTransaction.findMany({
          where,
          // `id` breaks a timestamp tie, so a page never repeats or skips a row.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true, amount: true, direction: true, reasonType: true, balanceAfter: true, currencyCode: true, createdAt: true },
        }),
        tx.tenantBillingTransaction.count({ where }),
      ]);

      return {
        balance: money(wallet.cachedBalance),
        currencyCode: wallet.currencyCode,
        total,
        page,
        pageSize,
        rows: rows.map((r) => ({
          id: r.id,
          direction: r.direction,
          reasonType: r.reasonType,
          amount: money(r.amount),
          balanceAfter: money(r.balanceAfter),
          currencyCode: r.currencyCode,
          createdAt: r.createdAt,
        })),
      };
    });
  }
}
