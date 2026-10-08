import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { PrismaService } from '../../prisma/prisma.service';
import { DepositQuoteService } from './deposit-quote.service';

export const otherGatewaySchema = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid(), paymentId: z.string().uuid() }).strict();
export type OtherGatewayBody = z.infer<typeof otherGatewaySchema>;
export type OtherGatewayAnswer = { paid: true } | { gateway: { displayName: string; category: string } | null };

/**
 * F-038-m (ADR-0109 point 9): the gateway an AI `checkout_help` names, asked
 * by worker-service at delivery — billing owns which gateways a user may pay
 * with, so the engine never guesses one.
 *
 * The user's own list as the top-up page shows it (`listGateways`: active,
 * verified, in the tenant's currency, secrets set, a known provider; an
 * in-chat gateway is left out — the message is read outside its chat), minus
 * the gateway that just failed, a test one, and one whose limits refuse the
 * amount tried. The first left, in the list's own order. `paid` when the user
 * paid after the attempt after all: the help is no longer owed.
 */
@Injectable()
export class OtherGatewayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: DepositQuoteService,
  ) {}

  find({ tenantId, userId, paymentId }: OtherGatewayBody): Promise<OtherGatewayAnswer> {
    return runWithTenant({ id: tenantId }, async (): Promise<OtherGatewayAnswer> => {
      const facts = await tenantTransaction(this.prisma, async (tx) => {
        const payment = await tx.paymentTransaction.findFirst({
          where: { id: paymentId, userId },
          select: { gatewayId: true, tenantGatewayConfigId: true, amountRequested: true, currencyCode: true, createdAt: true },
        });
        if (!payment) return null;
        const paid = await tx.paymentTransaction.findFirst({ where: { userId, status: 'success', createdAt: { gt: payment.createdAt } }, select: { id: true } });
        return { payment, paid: paid !== null };
      });
      if (!facts) return { gateway: null };
      if (facts.paid) return { paid: true };

      const { payment } = facts;
      const tried = payment.gatewayId ?? payment.tenantGatewayConfigId;
      const holds = (min: string | null, max: string | null) =>
        (min === null || payment.amountRequested.gte(new Prisma.Decimal(min))) && (max === null || payment.amountRequested.lte(new Prisma.Decimal(max)));
      const other = (await this.quotes.listGateways({ userId })).find(
        // A gateway's limits are in its own currency: compared only when that is the attempt's.
        (g) => g.id !== tried && !g.testing && (g.currencyCode !== payment.currencyCode || holds(g.minAmount, g.maxAmount)),
      );
      return { gateway: other ? { displayName: other.displayName, category: other.category } : null };
    });
  }
}
