import { Injectable } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { BudgetSubject } from '../attention/attention-budget.service';
import { AiReaderPrisma } from '../prisma/prisma.service';
import { QUIET_AFTER_FAILED_PAYMENT_MS, type QuietInputs } from './quiet-down';

const CALM: QuietInputs = { openTicket: false, lastFailedPaymentAt: null };

/**
 * F-1506: what the quiet-down rule reads, through `txnet_ai_reader` only
 * (invariant 7) — `ai.reader_open_ticket` (tickets have no `tenantId`, so a
 * view scopes them) and `billing.payment_transaction` under its RLS.
 *
 * A payment's failure time is its `createdAt`: the row records no other, and
 * an attempt fails or expires within minutes of starting.
 *
 * A reseller subject reads nothing: its admins' tickets and its platform
 * top-ups are not a customer's, and what silences a reseller is F-038-o's.
 */
@Injectable()
export class QuietDownReader {
  constructor(private readonly reader: AiReaderPrisma) {}

  async inputs(subject: BudgetSubject, now: Date): Promise<QuietInputs> {
    if (subject.kind !== 'user') return CALM;
    const { tenantId, id } = subject;
    const since = new Date(now.getTime() - QUIET_AFTER_FAILED_PAYMENT_MS);
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.reader, async (tx) => {
        const tickets = await tx.$queryRaw<Array<{ one: number }>>`
          SELECT 1 AS one FROM ai.reader_open_ticket WHERE "userId" = ${id}::uuid LIMIT 1`;
        const failed = await tx.paymentTransaction.findFirst({
          where: { userId: id, status: 'failed', createdAt: { gt: since } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        return { openTicket: tickets.length > 0, lastFailedPaymentAt: failed?.createdAt ?? null };
      }),
    );
  }
}
