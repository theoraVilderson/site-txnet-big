import { Injectable, Logger } from '@nestjs/common';
import { ConfirmationSource, PaymentStatus, Prisma, TenantType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AskAnswer, DepositReconciliationService } from './deposit-reconciliation.service';
import { DepositSettlementService, PAYMENT_SELECT } from './deposit-settlement';

/**
 * A person finishing a payment the gateway would not (F-092-z, ADR-0044
 * decision 6).
 *
 * Legacy's operator checked Zarinpal's own panel and topped the wallet up by
 * hand, outside any trail. This is that act, with three things legacy lacked:
 *
 * **Scope, like `gateway.manage`.** The platform owner may confirm any payment.
 * Any other tenant only one its own user made on its own
 * `tenant_gateway_config` — not a platform gateway's (the money is in the
 * platform's account, which the tenant cannot see) and not one taken under a
 * grant (it is in the lender's). Everything else is `payment_not_found`, so a
 * refusal says nothing about whether the row exists.
 *
 * **The gateway first, every time.** `confirm` asks once, by exactly the rules
 * reconciliation follows (`askOnce`). A gateway that confirmed, refused or
 * reported another amount has decided, and the person has not. Only silence or
 * `in_bank` lets a person credit — with the gateway's reference number and a
 * reason.
 *
 * **One path for the money.** The manual credit is `DepositSettlementService`'s
 * guarded flip with `admin_manual`, and its `payment_manual_confirm` audit row
 * commits in that same transaction (invariant 7; a credit with no trail is the
 * thing this replaces).
 */

export type ManualActor = { adminId: string; tenantId: string; ip: string };

export type ManualConfirmRejection = 'payment_not_found' | 'not_verifying';

export class ManualConfirmRefused extends Error {
  constructor(readonly reason: ManualConfirmRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ManualConfirmRefused';
  }
}

export type ManualOutcome = Exclude<AskAnswer['kind'], 'credited' | 'in_bank' | 'unanswered' | 'unaskable'> | 'credited' | 'unsettled' | 'confirmed_manually';

export type ManualAnswer = {
  paymentId: string;
  outcome: ManualOutcome;
  /** The gateway's own word, when it gave one. */
  gatewayStatus: string | null;
  referenceId: string | null;
};

export type VerifyingPaymentView = {
  id: string;
  tenantId: string | null;
  userId: string;
  source: 'platform' | 'tenant';
  gatewayId: string | null;
  gatewayName: string | null;
  providerName: string | null;
  amountRequested: string;
  amountCredited: string;
  chargedAmountMinor: string;
  authority: string | null;
  createdAt: Date;
  verifyAttempts: number;
  nextVerifyAt: Date | null;
  flaggedAt: Date | null;
};

const SCOPE_SELECT = {
  id: true,
  tenantId: true,
  status: true,
  nextVerifyAt: true,
  verifyFlaggedAt: true,
  gatewayId: true,
  tenantGatewayConfigId: true,
  grantId: true,
  tenantGatewayConfig: { select: { tenantId: true } },
} satisfies Prisma.PaymentTransactionSelect;

const VIEW_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  gatewayId: true,
  tenantGatewayConfigId: true,
  amountRequested: true,
  amountCredited: true,
  chargedAmountMinor: true,
  gatewayTrackingCode: true,
  createdAt: true,
  verifyAttempts: true,
  nextVerifyAt: true,
  verifyFlaggedAt: true,
  gateway: { select: { displayName: true, providerName: true } },
  tenantGatewayConfig: { select: { displayName: true, providerName: true } },
} satisfies Prisma.PaymentTransactionSelect;

/** Silence and `in_bank`: the only answers that leave the decision to a person. */
const UNSETTLED: readonly AskAnswer['kind'][] = ['in_bank', 'unanswered', 'unaskable'];

@Injectable()
export class ManualConfirmService {
  private readonly logger = new Logger(ManualConfirmService.name);

  constructor(
    /** The caller's own scope — used for one read: who is asking. */
    private readonly prisma: PrismaService,
    /** Finding the payment, and the list, across tenants; the scope rule below is the boundary. */
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly reconciliation: DepositReconciliationService,
    private readonly settlement: DepositSettlementService,
  ) {}

  /** Verifying and flagged payments the caller may act on, oldest first. */
  async list(actor: ManualActor): Promise<VerifyingPaymentView[]> {
    const owner = await this.isOwner(actor);
    const rows = await this.crossTenant.paymentTransaction.findMany({
      where: {
        status: PaymentStatus.pending,
        OR: [{ nextVerifyAt: { not: null } }, { verifyFlaggedAt: { not: null } }],
        ...(owner ? {} : this.tenantScope(actor)),
      },
      select: VIEW_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map((r) => {
      const gw = r.gateway ?? r.tenantGatewayConfig;
      return {
        id: r.id,
        tenantId: r.tenantId,
        userId: r.userId,
        source: r.gatewayId ? 'platform' : 'tenant',
        gatewayId: r.gatewayId ?? r.tenantGatewayConfigId,
        gatewayName: gw?.displayName ?? null,
        providerName: gw?.providerName ?? null,
        amountRequested: r.amountRequested.toFixed(2),
        amountCredited: r.amountCredited.toFixed(2),
        chargedAmountMinor: r.chargedAmountMinor.toString(),
        authority: r.gatewayTrackingCode,
        createdAt: r.createdAt,
        verifyAttempts: r.verifyAttempts,
        nextVerifyAt: r.nextVerifyAt,
        flaggedAt: r.verifyFlaggedAt,
      };
    });
  }

  /** Ask the gateway now. Whatever it settles is settled by the ordinary path. */
  async inquire(actor: ManualActor, paymentId: string): Promise<ManualAnswer> {
    const tenantId = await this.eligible(actor, paymentId);
    const asked = await runWithTenant({ id: tenantId }, () => this.reconciliation.askOnce(paymentId));
    return this.answerOf(paymentId, asked);
  }

  /** Ask first; credit by hand only if the gateway left it unsettled. */
  async confirm(actor: ManualActor, paymentId: string, input: { referenceId: string; reason: string }): Promise<ManualAnswer> {
    const tenantId = await this.eligible(actor, paymentId);
    return runWithTenant({ id: tenantId }, async () => {
      const asked = await this.reconciliation.askOnce(paymentId);
      if (!UNSETTLED.includes(asked.kind)) return this.answerOf(paymentId, asked);

      const payment = await tenantTransaction(this.prisma, (tx) =>
        tx.paymentTransaction.findFirst({ where: { id: paymentId }, select: PAYMENT_SELECT }),
      );
      if (!payment) throw new ManualConfirmRefused('payment_not_found', paymentId);

      const credited = await this.settlement.creditVerified(
        payment,
        { referenceId: input.referenceId, cardPan: null },
        ConfirmationSource.admin_manual,
        { adminId: actor.adminId, reason: input.reason, ip: actor.ip },
      );
      if (credited) this.logger.warn(`payment ${paymentId} confirmed by hand by ${actor.adminId} (gateway: ${asked.kind})`);
      return {
        paymentId,
        outcome: credited ? 'confirmed_manually' : 'already_settled',
        gatewayStatus: asked.gatewayStatus,
        referenceId: credited ? input.referenceId : null,
      };
    });
  }

  private answerOf(paymentId: string, asked: AskAnswer): ManualAnswer {
    const outcome: ManualOutcome = UNSETTLED.includes(asked.kind) ? 'unsettled' : (asked.kind as ManualOutcome);
    return { paymentId, outcome, gatewayStatus: asked.gatewayStatus, referenceId: asked.referenceId };
  }

  /** The payment's tenant, if the caller may act on it and it is verifying or flagged. */
  private async eligible(actor: ManualActor, paymentId: string): Promise<string> {
    const [owner, row] = await Promise.all([
      this.isOwner(actor),
      this.crossTenant.paymentTransaction.findUnique({ where: { id: paymentId }, select: SCOPE_SELECT }),
    ]);
    const inScope =
      row !== null &&
      row.tenantId !== null &&
      (owner ||
        (row.tenantId === actor.tenantId &&
          row.grantId === null &&
          row.tenantGatewayConfigId !== null &&
          row.tenantGatewayConfig?.tenantId === actor.tenantId));
    if (!inScope || !row?.tenantId) throw new ManualConfirmRefused('payment_not_found', paymentId);

    if (row.status !== PaymentStatus.pending || (row.nextVerifyAt === null && row.verifyFlaggedAt === null)) {
      throw new ManualConfirmRefused('not_verifying', paymentId);
    }
    return row.tenantId;
  }

  private tenantScope(actor: ManualActor): Prisma.PaymentTransactionWhereInput {
    return { tenantId: actor.tenantId, grantId: null, tenantGatewayConfig: { tenantId: actor.tenantId } };
  }

  /** As `GatewayAdminService.isOwner`: `tenant.tenant` has no RLS policy, so the caller's pool answers it. */
  private async isOwner(actor: ManualActor): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return tenant?.tenantType === TenantType.platform_owner;
  }
}
