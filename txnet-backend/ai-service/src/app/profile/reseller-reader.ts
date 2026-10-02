import { Injectable } from '@nestjs/common';
import { Prisma, TenantBillingModel } from '@prisma/client';
import {
  productQuotaStatementsOf,
  quotaTermsOf,
  RESELLER_QUOTA_KEYS,
  ResellerQuota,
  runWithTenant,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { AiReaderPrisma } from '../prisma/prisma.service';
import type { QuotaWindowInput, ResellerInputs } from './reseller-predictions';

const DAY_MS = 86_400_000;
/** Usage read back for the rate (7 days) and the sales trend (30 + 30). */
const USAGE_HISTORY_DAYS = 60;
const READ_TIMEOUT_MS = 30_000;

/** One row of `ai.reader_reseller` (`20261002001600_ai_reseller_inputs`). */
export type ResellerRow = {
  tenantId: string;
  ownerUserId: string;
  billingModel: TenantBillingModel;
  packageId: string | null;
  currentPeriodEnd: Date | null;
  renewalWarnedAt: Date | null;
  graceUntil: Date | null;
  nextPackageId: string | null;
  monthlyPrice: Prisma.Decimal | null;
  yearlyPrice: Prisma.Decimal | null;
  priceCurrency: string | null;
  walletBalance: Prisma.Decimal | null;
  walletCurrency: string | null;
};

/**
 * What the platform's run reads of its resellers (F-038-o1, ADR-0109 point 4),
 * through `txnet_ai_reader` only (invariant 7):
 *
 * - the list, through `ai.reader_reseller` in the **platform's** scope — a view
 *   that answers nothing to any other bound tenant;
 * - each reseller's quota statement in **that reseller's** scope, by
 *   shared-core's own read-only functions, so the terms are the ones the quota
 *   engine applies (billing contract.reseller-quota.md), never re-derived here.
 */
@Injectable()
export class ResellerReader {
  constructor(private readonly reader: AiReaderPrisma) {}

  resellers(platformTenantId: string): Promise<ResellerRow[]> {
    return runWithTenant({ id: platformTenantId }, () =>
      tenantTransaction(this.reader, (tx) =>
        tx.$queryRaw<ResellerRow[]>`
          SELECT "tenantId", "ownerUserId", "billingModel", "packageId", "currentPeriodEnd", "renewalWarnedAt", "graceUntil",
                 "nextPackageId", "monthlyPrice", "yearlyPrice", "priceCurrency", "walletBalance", "walletCurrency"
          FROM ai.reader_reseller
          ORDER BY "tenantId"`,
      ),
    );
  }

  inputs(row: ResellerRow, now: Date): Promise<ResellerInputs> {
    const tenantId = row.tenantId;
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(
        this.reader,
        async (tx) => {
          const windows: QuotaWindowInput[] = [];
          // One after the other: an interactive transaction is one connection.
          for (const key of RESELLER_QUOTA_KEYS) {
            const terms = await quotaTermsOf(tx, tenantId, key);
            if (!terms) continue;
            const s = await ResellerQuota.meterStatementOf(tx, tenantId, terms, now);
            for (const w of s.windows) windows.push(windowOf(s.meter, w, terms.overage.mode));
          }
          for (const s of await productQuotaStatementsOf(tx, tenantId, now)) {
            for (const w of s.windows) windows.push(windowOf(s.meter, w, s.overage.mode));
          }

          const since = new Date(now.getTime() - USAGE_HISTORY_DAYS * DAY_MS);
          const week = new Date(now.getTime() - 7 * DAY_MS);
          const month = new Date(now.getTime() - 30 * DAY_MS);
          const usage = await tx.$queryRaw<Array<{ meter: string; last7d: bigint | null; firstAt: Date; last30: bigint | null; prev30: bigint | null }>>`
            SELECT "meter",
                   SUM("qty") FILTER (WHERE "createdAt" >= ${week}) AS "last7d",
                   MIN("createdAt") AS "firstAt",
                   SUM("qty") FILTER (WHERE "createdAt" >= ${month}) AS "last30",
                   SUM("qty") FILTER (WHERE "createdAt" < ${month}) AS "prev30"
            FROM tenant.reseller_quota_usage
            WHERE "tenantId" = ${tenantId}::uuid AND "releasedAt" IS NULL AND "createdAt" >= ${since} AND "createdAt" <= ${now}
            GROUP BY "meter"`;
          const sales = { last30: 0, prev30: 0 };
          for (const u of usage) {
            if (!u.meter.startsWith('product:')) continue;
            sales.last30 += Number(u.last30 ?? 0);
            sales.prev30 += Number(u.prev30 ?? 0);
          }

          const renewalPrice = row.billingModel === TenantBillingModel.subscription_yearly ? row.yearlyPrice : row.billingModel === TenantBillingModel.subscription_monthly ? row.monthlyPrice : null;
          return {
            tenantId,
            windows,
            usage: usage.map((u) => ({ meter: u.meter, last7d: Number(u.last7d ?? 0), firstAt: u.firstAt })),
            sales,
            subscription: row.currentPeriodEnd
              ? {
                  currentPeriodEnd: row.currentPeriodEnd,
                  renewalWarnedAt: row.renewalWarnedAt,
                  graceUntil: row.graceUntil,
                  nextPackageId: row.nextPackageId,
                  renewalPrice,
                  priceCurrency: row.priceCurrency,
                }
              : null,
            wallet: row.walletBalance !== null && row.walletCurrency ? { balance: row.walletBalance, currencyCode: row.walletCurrency } : null,
          };
        },
        { timeout: READ_TIMEOUT_MS },
      ),
    );
  }
}

function windowOf(meter: string, w: { period: { kind: QuotaWindowInput['period']; start: Date; end: Date }; included: number | null; includedUsed: number; overageQty: number }, mode: QuotaWindowInput['mode']): QuotaWindowInput {
  return { meter, period: w.period.kind, start: w.period.start, end: w.period.end, included: w.included, includedUsed: w.includedUsed, overageQty: w.overageQty, mode };
}
