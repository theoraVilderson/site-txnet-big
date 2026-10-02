import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { AiReaderPrisma, PrismaService } from '../prisma/prisma.service';
import { matchOutcome, measured, OUTCOME_WINDOW_DAYS, outcomeWrite, UNMEASURED_STEPS, upliftReport, type OutcomeEvent, type UpliftReport } from './outcome';

/** The types an outcome is matched for; another type is never converted. */
const MATCHED_TYPES = ['renew', 'resize_up', 'resize_down', 'top_up_wallet'] as const;
/** A row may be sent up to 7 days after its decision, then has 7 days to convert; one hour of slack for the run. */
const LOOKBACK_MS = (2 * OUTCOME_WINDOW_DAYS * 24 + 1) * 3_600_000;
const PAGE = 500;
/** The longest period one report reads. */
export const REPORT_MAX_DAYS = 366;

/**
 * F-038-i: records conversions hourly, after the decision run, and builds the
 * uplift report (`outcome.ts` holds the rules). Rows are read and written on
 * the app pool; the purchases, renewals and top-ups they are matched against
 * through `txnet_ai_reader` (invariant 7): `billing.invoice` `paid`, the
 * user's own `entitlement.grant_renewal` (`actorUserId` = the subject, a plan
 * period), and a `payment_gateway` credit on the user's wallet
 * (`ai.reader_wallet` names whose).
 *
 * Safe to run twice: only a row with no `convertedAt` is matched, and every
 * write is conditional on the status it read.
 */
@Injectable()
export class OutcomeRun {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: AiReaderPrisma,
  ) {}

  async recordTenant(tenantId: string, now: Date): Promise<{ converted: number }> {
    const since = new Date(now.getTime() - LOOKBACK_MS);
    let converted = 0;
    let cursor: string | null = null;
    for (;;) {
      const rows = await this.write(tenantId, (tx) =>
        tx.aiAction.findMany({
          where: {
            tenantId,
            subjectKind: 'user',
            actionType: { in: [...MATCHED_TYPES] },
            convertedAt: null,
            createdAt: { gte: since },
            OR: [{ status: { not: 'suppressed' } }, { suppressedBy: { notIn: [...UNMEASURED_STEPS] } }],
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true, subjectId: true, actionType: true, status: true, suppressedBy: true, createdAt: true, sentAt: true, reasons: true },
          orderBy: { id: 'asc' },
          take: PAGE,
        }),
      );
      if (rows.length === 0) break;
      const events = await this.events(tenantId, [...new Set(rows.map((r) => r.subjectId))], since);
      for (const row of rows) {
        if (!measured(row)) continue;
        const hit = matchOutcome(row, events);
        if (!hit) continue;
        const priced = hit.amount !== null && hit.currencyCode !== null;
        const change = outcomeWrite(row.status);
        const { count } = await this.write(tenantId, (tx) =>
          tx.aiAction.updateMany({
            where: { id: row.id, tenantId, status: row.status, convertedAt: null },
            data: {
              ...change,
              ...(change.status === 'accepted' ? { outcomeAt: hit.at } : {}),
              convertedAt: hit.at,
              convertedAmount: priced ? new Prisma.Decimal(hit.amount!) : null,
              convertedCurrency: priced ? hit.currencyCode : null,
            },
          }),
        );
        converted += count;
      }
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].id;
    }
    return { converted };
  }

  /** The uplift of each type over the holdout for decisions in `[from, to)`. */
  async report(tenantId: string, from: Date, to: Date): Promise<UpliftReport> {
    const rows = await this.write(tenantId, (tx) =>
      tx.aiAction.findMany({
        where: { tenantId, subjectKind: 'user', createdAt: { gte: from, lt: to } },
        select: {
          subjectId: true, actionType: true, status: true, suppressedBy: true, createdAt: true, deadline: true, reasons: true,
          convertedAt: true, convertedAmount: true, convertedCurrency: true,
        },
      }),
    );
    return upliftReport(
      rows.map((r) => ({ ...r, convertedAmount: r.convertedAmount ? r.convertedAmount.toFixed(2) : null })),
      { from, to },
    );
  }

  private events(tenantId: string, userIds: string[], since: Date): Promise<OutcomeEvent[]> {
    const ids = Prisma.sql`ARRAY[${Prisma.join(userIds)}]::uuid[]`;
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.reader, async (tx) => {
        const purchases = await tx.$queryRaw<Array<{ ref: string; userId: string; variantId: string; amount: string; currencyCode: string; at: Date }>>`
          SELECT "id" AS ref, "userId", "variantId", "total"::text AS amount, "currencyCode", "createdAt" AS at
          FROM billing.invoice
          WHERE "status" = 'paid'::"billing"."InvoiceStatus" AND "userId" = ANY(${ids}) AND "createdAt" >= ${since}`;
        const renewals = await tx.$queryRaw<Array<{ ref: string; userId: string; grantId: string; at: Date }>>`
          SELECT "id" AS ref, "actorUserId" AS "userId", "grantId", "createdAt" AS at
          FROM entitlement.grant_renewal
          WHERE "plan" AND "actorUserId" = ANY(${ids}) AND "createdAt" >= ${since}`;
        const topUps = await tx.$queryRaw<Array<{ ref: string; userId: string; amount: string; currencyCode: string; at: Date }>>`
          SELECT t."id" AS ref, w."userId", t."amount"::text AS amount, t."currencyCode", t."createdAt" AS at
          FROM billing.wallet_transaction t JOIN ai.reader_wallet w ON w."id" = t."walletId"
          WHERE t."direction" = 'credit'::"billing"."LedgerDirection" AND t."reasonType" = 'payment_gateway'::"billing"."WalletReasonType"
            AND w."userId" = ANY(${ids}) AND t."createdAt" >= ${since}`;
        return [
          ...purchases.map((p): OutcomeEvent => ({ kind: 'purchase', ref: p.ref, userId: p.userId, at: p.at, variantId: p.variantId, grantId: null, amount: p.amount, currencyCode: p.currencyCode })),
          ...renewals.map((r): OutcomeEvent => ({ kind: 'renewal', ref: r.ref, userId: r.userId, at: r.at, variantId: null, grantId: r.grantId, amount: null, currencyCode: null })),
          ...topUps.map((t): OutcomeEvent => ({ kind: 'top_up', ref: t.ref, userId: t.userId, at: t.at, variantId: null, grantId: null, amount: t.amount, currencyCode: t.currencyCode })),
        ];
      }),
    );
  }

  private write<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runWithTenant({ id: tenantId }, () => tenantTransaction(this.prisma, fn));
  }
}
