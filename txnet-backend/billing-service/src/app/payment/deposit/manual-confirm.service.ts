import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfirmationSource, PaymentStatus, Prisma, TenantType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AskAnswer, DepositReconciliationService } from './deposit-reconciliation.service';
import { DepositSettlementService, PAYMENT_SELECT } from './deposit-settlement';
import { attachAuthority } from './payment-callback-url';

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
 * **The pool follows the caller (ADR-0053, D-37).** Finding the payment and the
 * list run on the cross-tenant pool for the platform owner only; any other
 * tenant reads in a `tenantTransaction` on the app pool, where RLS on
 * `payment_transaction` stands behind the scope rule. Every write already runs
 * in the payment's own tenant.
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

/**
 * `not_open`: the payment is `success` or `failed` — settled, not a person's to
 * reopen (F-092-af; `not_verifying` before it). `authority_present` and
 * `authority_taken` answer attaching an authority (F-092-af).
 */
export type ManualConfirmRejection = 'payment_not_found' | 'not_open' | 'authority_present' | 'authority_taken';

export class ManualConfirmRefused extends Error {
  constructor(readonly reason: ManualConfirmRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ManualConfirmRefused';
  }
}

/**
 * Spelled out, not derived: the panel's screen reads this union from this file
 * to prove it has a sentence for every word (F-093-n).
 */
export type ManualOutcome =
  | 'credited'
  | 'already_settled'
  | 'refused'
  | 'mismatch'
  | 'unsettled'
  | 'confirmed_manually'
  /** F-092-ak: a person closed it — the gateway saw no money. */
  | 'rejected_manually'
  /** F-092-ak: not rejected — the payer is still at the bank and may be about to pay. */
  | 'still_in_bank';

export type ManualAnswer = {
  paymentId: string;
  outcome: ManualOutcome;
  /** The gateway's own word, when it gave one. */
  gatewayStatus: string | null;
  referenceId: string | null;
};

export type VerifyingPaymentView = {
  id: string;
  /** `pending` or `expired` (F-092-af). */
  status: 'pending' | 'expired';
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
  gatewayTrackingCode: true,
  nextVerifyAt: true,
  verifyFlaggedAt: true,
  gatewayId: true,
  tenantGatewayConfigId: true,
  grantId: true,
  tenantGatewayConfig: { select: { tenantId: true } },
} satisfies Prisma.PaymentTransactionSelect;

const VIEW_SELECT = {
  id: true,
  status: true,
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
    /** Who is asking; a tenant admin's reads; every write, in the payment's tenant. */
    private readonly prisma: PrismaService,
    /** The platform owner's reads, across tenants. See the class comment. */
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly reconciliation: DepositReconciliationService,
    private readonly settlement: DepositSettlementService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  /**
   * Every open payment the caller may act on — `pending` or `expired`,
   * verifying or not, with or without an authority — made inside the
   * reconciliation lookback, oldest first (F-092-af, ADR-0046 decision 7). A
   * payer in a hurry reaches a person before the jobs reach the payment.
   */
  async list(actor: ManualActor): Promise<VerifyingPaymentView[]> {
    const owner = await this.isOwner(actor);
    const lookbackSec = this.config.get('RECONCILIATION_LOOKBACK_SEC', { infer: true });
    const rows = await this.read(owner, (db) =>
      db.paymentTransaction.findMany({
        where: {
          status: { in: [PaymentStatus.pending, PaymentStatus.expired] },
          createdAt: { gte: new Date(Date.now() - lookbackSec * 1000) },
          ...(owner ? {} : this.tenantScope(actor)),
        },
        select: VIEW_SELECT,
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
    );
    return rows.map((r) => {
      const gw = r.gateway ?? r.tenantGatewayConfig;
      return {
        id: r.id,
        status: r.status as 'pending' | 'expired',
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

  /**
   * Give a payment the authority its write lost — read by a person off the
   * gateway's own panel — then ask the gateway about it at once (F-092-af, the
   * third way of ADR-0046 decision 4). Only a payment with none: nothing a
   * person types overwrites an authority, and the unique index refuses one
   * another payment holds. A wrong authority costs nothing: the gateway refuses
   * it, and the refusal is recorded like any other.
   */
  async attachAuthority(actor: ManualActor, paymentId: string, authority: string): Promise<ManualAnswer> {
    const { tenantId, hasAuthority } = await this.eligibleRow(actor, paymentId);
    if (hasAuthority) throw new ManualConfirmRefused('authority_present', paymentId);
    return runWithTenant({ id: tenantId }, async () => {
      let attached: boolean;
      try {
        attached = await tenantTransaction(this.prisma, (tx) => attachAuthority(tx, paymentId, authority));
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ManualConfirmRefused('authority_taken', paymentId);
        }
        throw e;
      }
      if (!attached) throw new ManualConfirmRefused('authority_present', paymentId);
      this.logger.warn(`payment ${paymentId}: authority attached by hand by ${actor.adminId}`);
      return this.answerOf(paymentId, await this.reconciliation.askOnce(paymentId));
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

  /**
   * End a payment nobody paid (F-092-ak). Ask first, as for a confirmation:
   * money the gateway can see — `credited`, `already_settled`, `mismatch` — is
   * never a person's to refuse, and `in_bank` is a payer who may be about to
   * pay, so both answer and write nothing. Silence, no authority to ask about,
   * or a refusal that left the row open (`authority_invalid`) let a person close
   * it, with a reason, through `DepositSettlementService.rejectManually`.
   */
  async reject(actor: ManualActor, paymentId: string, input: { reason: string }): Promise<ManualAnswer> {
    const tenantId = await this.eligible(actor, paymentId);
    return runWithTenant({ id: tenantId }, async () => {
      const asked = await this.reconciliation.askOnce(paymentId);
      if (asked.kind === 'in_bank') {
        return { paymentId, outcome: 'still_in_bank', gatewayStatus: asked.gatewayStatus, referenceId: null };
      }
      if (asked.kind === 'credited' || asked.kind === 'already_settled' || asked.kind === 'mismatch') {
        return this.answerOf(paymentId, asked);
      }

      const payment = await tenantTransaction(this.prisma, (tx) =>
        tx.paymentTransaction.findFirst({ where: { id: paymentId }, select: PAYMENT_SELECT }),
      );
      if (!payment) throw new ManualConfirmRefused('payment_not_found', paymentId);

      const closed = await this.settlement.rejectManually(payment, {
        adminId: actor.adminId,
        reason: input.reason,
        ip: actor.ip,
      });
      return {
        paymentId,
        // Not closed here: the ask's own `failed` closed it (F-092-aj), or another path settled it.
        outcome: closed ? 'rejected_manually' : asked.kind === 'refused' ? 'refused' : 'already_settled',
        gatewayStatus: asked.gatewayStatus,
        referenceId: null,
      };
    });
  }

  private answerOf(paymentId: string, asked: AskAnswer): ManualAnswer {
    const outcome: ManualOutcome = UNSETTLED.includes(asked.kind) ? 'unsettled' : (asked.kind as ManualOutcome);
    return { paymentId, outcome, gatewayStatus: asked.gatewayStatus, referenceId: asked.referenceId };
  }

  /** The payment's tenant, if the caller may act on it and it is still open. */
  private async eligible(actor: ManualActor, paymentId: string): Promise<string> {
    return (await this.eligibleRow(actor, paymentId)).tenantId;
  }

  private async eligibleRow(actor: ManualActor, paymentId: string): Promise<{ tenantId: string; hasAuthority: boolean }> {
    const owner = await this.isOwner(actor);
    const row = await this.read(owner, (db) => db.paymentTransaction.findUnique({ where: { id: paymentId }, select: SCOPE_SELECT }));
    const inScope =
      row !== null &&
      row.tenantId !== null &&
      (owner ||
        (row.tenantId === actor.tenantId &&
          row.grantId === null &&
          row.tenantGatewayConfigId !== null &&
          row.tenantGatewayConfig?.tenantId === actor.tenantId));
    if (!inScope || !row?.tenantId) throw new ManualConfirmRefused('payment_not_found', paymentId);

    // Open is all it takes (F-092-af): a settled payment is not a person's to reopen.
    if (row.status !== PaymentStatus.pending && row.status !== PaymentStatus.expired) {
      throw new ManualConfirmRefused('not_open', paymentId);
    }
    return { tenantId: row.tenantId, hasAuthority: row.gatewayTrackingCode !== null };
  }

  /** A read on the pool that serves this caller (ADR-0053): the owner's across tenants, anyone else's in their own. */
  private read<T>(owner: boolean, fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return owner ? this.crossTenant.$transaction(fn) : tenantTransaction(this.prisma, fn);
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
