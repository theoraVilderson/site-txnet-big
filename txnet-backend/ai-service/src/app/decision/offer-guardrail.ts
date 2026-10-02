import { Injectable } from '@nestjs/common';
import type { AiActionType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * F-038-e, the guardrail step (ADR-0109 points 8, 9): a candidate carrying an
 * offer goes out only with an offer the tenant still runs, made for that
 * action type. A candidate with no offer — every `renew` and resize — passes
 * without a read. The offer's daily budget, its once-per-account rule and its
 * "renewal without it under 0.5" are F-038-f's, which is where offers are made.
 */
@Injectable()
export class OfferGuardrails {
  constructor(private readonly prisma: PrismaService) {}

  async active(tenantId: string, offerId: string, actionType: AiActionType): Promise<boolean> {
    const offer = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.aiOffer.findFirst({ where: { id: offerId, tenantId, isActive: true, actionType }, select: { id: true } }),
      ),
    );
    return offer !== null;
  }
}
