import { Injectable, Logger } from '@nestjs/common';
import { PaymentProviderName, Prisma, TenantType } from '@prisma/client';
import { operatingCurrencyOf } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The operator surface over granted gateways (ADR-0041 §5/§6, F-096-e).
 *
 * F-096-a..d made a granted gateway work end to end: the owner's merchant id is
 * charged, the borrowing tenant's user is credited, and the collection accrues
 * as a debt in `gateway_settlement_entry`. Nothing until now could *create* a
 * grant except a SQL client, and nothing could say what the platform owed. This
 * is both, plus the payout that discharges it.
 *
 * **Why it reads on the cross-tenant pool, and what stands in for RLS.**
 * All three settlement tables carry `tenantId` = the **borrowing** tenant and
 * are isolated on it, which is exactly right for the borrower: a reseller sees
 * the grants made to it and the debt owed to it, and nothing else. It is the
 * wrong key for this surface, whose whole job is to look *across* tenants — the
 * platform owner bound to its own `app.tenant_id` sees none of the rows it is
 * responsible for. So these routes read and write on `CrossTenantPrismaService`
 * (the `txnet_cross_tenant_user` login role; a policy, never `BYPASSRLS`).
 *
 * That moves the whole boundary into this file, so it is stated twice and
 * proved once:
 *
 * 1. `SettlementPermissionGuard` requires `settlement.manage` on the caller's
 *    role — the gate's own header, which Traefik strips from the client;
 * 2. every operation below opens with {@link assertOperator}, which reads the
 *    caller's tenant on the **application** pool and refuses anything that is
 *    not `TenantType.platform_owner`.
 *
 * The second is the one that matters. A reseller's admin who was granted
 * `settlement.manage` — by its own tenant's role editor, which the platform
 * owner does not control — would otherwise reach a pool that sees every
 * tenant's ledger and be able to grant its own tenant the platform's gateway.
 * The check is in the service and not only in a guard because it is the rule,
 * not a route decoration: a second controller added later gets it by calling
 * these methods at all.
 *
 * **Stated limit, not a workaround.** There is no database-level backstop. RLS
 * on these tables keys on the borrower, so it cannot express "only the platform
 * owner may INSERT"; a `WITH CHECK (current_user = 'txnet_cross_tenant_user')`
 * policy would only restate the pool this service already chose. A bug in
 * `assertOperator` is therefore a real hole, which is why it is one function
 * called from one place per operation and asserted in `settlement.service.spec.ts`
 * for every operation on this class. Closing it properly wants a platform-owner
 * marker the database can see, which is the `admin_audit_log` gap the F-096-e
 * row names and is a decision of its own.
 */

export type SettlementRejection =
  | 'not_platform_owner'
  | 'gateway_not_found'
  | 'tenant_not_found'
  | 'grant_to_owner'
  | 'gateway_not_grantable'
  | 'already_granted'
  | 'grant_not_found'
  | 'already_withdrawn'
  | 'amount_not_positive'
  | 'exceeds_outstanding';

/** A refusal with a reason the controller can turn into a message. */
export class SettlementRefused extends Error {
  constructor(readonly reason: SettlementRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'SettlementRefused';
  }
}

/** Who is acting, as the gate proved it. Never taken from a body. */
export type Operator = {
  adminId: string;
  tenantId: string;
  ip: string;
};

/** Exactly one of the two, like `payment_transaction` and the grant row itself. */
export type GrantTarget = {
  gatewayId?: string | null;
  tenantGatewayConfigId?: string | null;
};

export type CreateGrantInput = GrantTarget & {
  /** The **borrowing** tenant — the one the grant is to. */
  tenantId: string;
  note?: string | null;
};

export type RecordPayoutInput = {
  /** The tenant being paid. */
  tenantId: string;
  amount: Prisma.Decimal;
  method?: string | null;
  reference?: string | null;
  /**
   * A key an operator typed, stored verbatim. Nothing resolves or serves it:
   * the object store is D-8's port and lands with F-033, at which point the
   * upload writes this same column and no schema changes.
   */
  proofAttachmentKey?: string | null;
  notes?: string | null;
};

export type OwedRow = {
  tenantId: string;
  accrued: Prisma.Decimal;
  paidOut: Prisma.Decimal;
  outstanding: Prisma.Decimal;
};

const ZERO = new Prisma.Decimal(0);

/**
 * The `classid` half of the payout advisory lock (F-096-g), paired with
 * `hashtext(tenantId)` as the `objid`. A fixed namespace of our own, so this
 * lock cannot collide with another feature that locks on the same tenant id:
 * `pg_advisory_xact_lock(int, int)` shares one global space with every other
 * advisory lock in the database.
 */
const PAYOUT_LOCK = 96_07;

/** Whichever client the two settlement ledgers are being summed on. */
type LedgerReader = Pick<
  CrossTenantPrismaService,
  'gatewaySettlementEntry' | 'gatewaySettlementPayout'
>;

/**
 * Which providers a grant may lend (D-32, F-104-p). An in-chat payment is made
 * inside the owning tenant's own bot or Mini App, which the borrowing tenant's
 * user never talks to — so a lent `telegram_stars` or `bale` gateway could not
 * be paid at all. Exhaustive, so a new provider does not compile until someone
 * decides.
 */
const GRANTABLE: Record<PaymentProviderName, boolean> = {
  zarinpal: true,
  idpay: true,
  nowpayments: true,
  stripe: true,
  oxapay: true,
  airwallex: true,
  telegram_stars: false,
  bale: false,
};

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    /** The caller's own tenant, bound by RLS — used for one read: who is asking. */
    private readonly prisma: PrismaService,
    /** Every tenant's settlement rows, by policy. See the class comment. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /**
   * The door. Refuses any caller whose tenant is not the platform owner.
   *
   * Read on the application pool, inside the caller's own scope, so the answer
   * is about the tenant the gate forwarded and not one named in a body.
   * `tenant.tenant` carries no `tenantId` column and so no RLS policy, which is
   * what lets any connection answer this at all (`deposit-pricing.ts` says the
   * same thing for the same reason).
   */
  private async assertOperator(operator: Operator): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: operator.tenantId },
      select: { tenantType: true },
    });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new SettlementRefused('not_platform_owner', operator.tenantId);
    }
  }

  /**
   * Which tenant owns the gateway a grant names, and that it exists at all.
   *
   * Re-derived here rather than trusted, exactly as `granted-vault-access.ts`
   * re-derives it at charge time: a `payment_gateway` row is the platform
   * owner's by definition (it carries no tenant column), and a
   * `tenant_gateway_config` row is its own `tenantId`'s.
   */
  private async ownerOf(
    target: GrantTarget,
  ): Promise<{ ownerTenantId: string; providerName: PaymentProviderName }> {
    if (target.gatewayId) {
      const gateway = await this.all.paymentGateway.findUnique({
        where: { id: target.gatewayId },
        select: { id: true, providerName: true },
      });
      if (!gateway) throw new SettlementRefused('gateway_not_found', target.gatewayId);
      const owner = await this.all.tenant.findFirst({
        where: { tenantType: TenantType.platform_owner },
        select: { id: true },
      });
      if (!owner) throw new SettlementRefused('tenant_not_found', 'platform owner');
      return { ownerTenantId: owner.id, providerName: gateway.providerName };
    }

    const config = await this.all.tenantGatewayConfig.findUnique({
      where: { id: target.tenantGatewayConfigId ?? '' },
      select: { tenantId: true, providerName: true },
    });
    if (!config) {
      throw new SettlementRefused('gateway_not_found', target.tenantGatewayConfigId ?? '(none)');
    }
    return { ownerTenantId: config.tenantId, providerName: config.providerName };
  }

  /**
   * Grant a gateway to a tenant that does not own it (ADR-0041 §1).
   *
   * Three refusals carry the rules rather than a database error:
   *
   * - **granting a tenant its own gateway** is refused. It is not harmless:
   *   `deposit-pricing.ts` lists a tenant's own gateways and its granted ones
   *   as two groups, so the gateway would appear twice on the top-up screen —
   *   and worse, a payment through it would accrue a settlement debt from the
   *   tenant to itself, money the platform never held;
   * - **an in-chat gateway** (`telegram_stars`, `bale`) is refused — see
   *   {@link GRANTABLE};
   * - **a second live grant of the same gateway to the same tenant** is
   *   refused. Nothing downstream picks between two, and withdrawing one would
   *   leave the gateway working with no visible reason why.
   *
   * The grant and its audit row are written in one transaction, for the reason
   * F-096-d writes the accrual inside the crediting one: a grant that exists
   * with nobody's name on it is a tenant collecting money on the platform's
   * gateway with no record of who allowed it.
   */
  async createGrant(input: CreateGrantInput, operator: Operator) {
    await this.assertOperator(operator);

    const named = [input.gatewayId, input.tenantGatewayConfigId].filter(Boolean);
    if (named.length !== 1) {
      throw new SettlementRefused('gateway_not_found', 'exactly one of gatewayId / tenantGatewayConfigId');
    }

    const borrower = await this.all.tenant.findUnique({
      where: { id: input.tenantId },
      select: { id: true },
    });
    if (!borrower) throw new SettlementRefused('tenant_not_found', input.tenantId);

    const { ownerTenantId, providerName } = await this.ownerOf(input);
    if (!GRANTABLE[providerName]) {
      throw new SettlementRefused('gateway_not_grantable', providerName);
    }
    if (ownerTenantId === input.tenantId) {
      throw new SettlementRefused('grant_to_owner', input.tenantId);
    }

    const existing = await this.all.paymentGatewayGrant.findFirst({
      where: {
        tenantId: input.tenantId,
        isActive: true,
        gatewayId: input.gatewayId ?? null,
        tenantGatewayConfigId: input.tenantGatewayConfigId ?? null,
      },
      select: { id: true },
    });
    if (existing) throw new SettlementRefused('already_granted', existing.id);

    const grant = await this.all.$transaction(async (tx) => {
      const created = await tx.paymentGatewayGrant.create({
        data: {
          tenantId: input.tenantId,
          gatewayId: input.gatewayId ?? null,
          tenantGatewayConfigId: input.tenantGatewayConfigId ?? null,
          grantedByAdminId: operator.adminId,
          note: input.note ?? null,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: input.tenantId,
          adminId: operator.adminId,
          action: 'gateway_grant_create',
          targetEntityType: 'gateway_grant',
          targetEntityId: created.id,
          oldValue: Prisma.DbNull,
          newValue: {
            tenantId: input.tenantId,
            gatewayId: input.gatewayId ?? null,
            tenantGatewayConfigId: input.tenantGatewayConfigId ?? null,
            ownerTenantId,
          },
          adminIpAddress: operator.ip,
        },
      });
      return created;
    });

    this.logger.log(`grant ${grant.id} to ${input.tenantId} by ${operator.adminId}`);
    return grant;
  }

  /**
   * Withdraw a grant (ADR-0041 §6). Withdrawn, never deleted: the payments
   * taken under it still point at it, and what was owed stays explicable.
   *
   * Refused rather than made idempotent when the grant is already withdrawn.
   * A second withdrawal is either a double-click or an operator acting on a
   * stale screen, and in both cases a second audit row naming a second admin
   * would misdescribe who stopped it.
   */
  async withdrawGrant(grantId: string, operator: Operator) {
    await this.assertOperator(operator);

    const grant = await this.all.paymentGatewayGrant.findUnique({
      where: { id: grantId },
      select: { id: true, tenantId: true, isActive: true },
    });
    if (!grant) throw new SettlementRefused('grant_not_found', grantId);
    if (!grant.isActive) throw new SettlementRefused('already_withdrawn', grantId);

    const withdrawnAt = new Date();
    await this.all.$transaction(async (tx) => {
      // `updateMany` with `isActive: true` in the filter, not `update`: two
      // operators on the same screen would otherwise both write a withdrawal
      // and both audit rows would claim to be the one that stopped it.
      const { count } = await tx.paymentGatewayGrant.updateMany({
        where: { id: grantId, isActive: true },
        data: { isActive: false, withdrawnAt, withdrawnByAdminId: operator.adminId },
      });
      if (count === 0) throw new SettlementRefused('already_withdrawn', grantId);

      await tx.adminAuditLog.create({
        data: {
          tenantId: grant.tenantId,
          adminId: operator.adminId,
          action: 'gateway_grant_withdraw',
          targetEntityType: 'gateway_grant',
          targetEntityId: grantId,
          oldValue: { isActive: true },
          newValue: { isActive: false, withdrawnAt: withdrawnAt.toISOString() },
          adminIpAddress: operator.ip,
        },
      });
    });

    this.logger.log(`grant ${grantId} withdrawn by ${operator.adminId}`);
    return { id: grantId, isActive: false, withdrawnAt };
  }

  /** Every grant the platform has made, newest first. Optionally one tenant's. */
  async listGrants(operator: Operator, tenantId?: string) {
    await this.assertOperator(operator);
    return this.all.paymentGatewayGrant.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { grantedAt: 'desc' },
      take: 200,
    });
  }

  /**
   * What is owed, per tenant: every accrual minus every payout (ADR-0041 §5).
   *
   * Summed from the two ledgers on every call rather than kept as a running
   * balance on the tenant. The ledgers are append-only and the arithmetic is
   * two `groupBy`s; a cached total is a second source of truth for money, and
   * the first time it disagreed with the rows there would be no way to say
   * which was right.
   *
   * Tenants with a payout and no accrual appear too — that is an over-payment
   * or a payout recorded against the wrong tenant, and hiding it would make the
   * one row an operator most needs to see the one row they cannot.
   */
  async owed(operator: Operator): Promise<OwedRow[]> {
    await this.assertOperator(operator);

    const [accruals, payouts] = await Promise.all([
      this.all.gatewaySettlementEntry.groupBy({
        by: ['tenantId'],
        _sum: { amount: true },
      }),
      this.all.gatewaySettlementPayout.groupBy({
        by: ['tenantId'],
        _sum: { amount: true },
      }),
    ]);

    const rows = new Map<string, OwedRow>();
    const row = (tenantId: string) => {
      const found = rows.get(tenantId) ?? {
        tenantId,
        accrued: ZERO,
        paidOut: ZERO,
        outstanding: ZERO,
      };
      rows.set(tenantId, found);
      return found;
    };

    for (const a of accruals) row(a.tenantId).accrued = a._sum.amount ?? ZERO;
    for (const p of payouts) row(p.tenantId).paidOut = p._sum.amount ?? ZERO;
    for (const r of rows.values()) r.outstanding = r.accrued.minus(r.paidOut);

    return [...rows.values()].sort((a, b) => b.outstanding.comparedTo(a.outstanding));
  }

  /**
   * One tenant's outstanding balance, from the same two ledgers.
   *
   * `on` is the client to read it with: the payout path passes its own
   * transaction, so the sum it checks is the one it then writes against.
   */
  private async outstandingFor(
    tenantId: string,
    on: LedgerReader = this.all,
  ): Promise<Prisma.Decimal> {
    const [accrued, paidOut] = await Promise.all([
      on.gatewaySettlementEntry.aggregate({
        where: { tenantId },
        _sum: { amount: true },
      }),
      on.gatewaySettlementPayout.aggregate({
        where: { tenantId },
        _sum: { amount: true },
      }),
    ]);
    return (accrued._sum.amount ?? ZERO).minus(paidOut._sum.amount ?? ZERO);
  }

  /**
   * Record a payout an operator already made outside the system (ADR-0041 §5).
   *
   * Never automatic, and never larger than what is outstanding. The second is
   * the rule this method exists for: the money has already left a bank account
   * by the time anyone reaches this route, so the recording cannot undo a
   * mistake — but a payout of 1,000 where 100 was owed is a typo far more often
   * than it is a real transfer, and the ledger, not the operator's memory, is
   * what ADR-0041 §5 makes the authority on what is still owed. An operator who
   * really did over-pay has a true thing to record and no way to record it
   * here; that wants an ADR, not a silently negative balance.
   *
   * **The check and the write are one act (F-096-g).** The balance is summed
   * from two ledgers, so there is no row to lock and no unique constraint to
   * lean on: a check outside the transaction is a read of a number that any
   * other payout can move before the insert lands. Two operators on one screen
   * — or one operator's double submit — would each read 60.00 outstanding and
   * each write 60.00, and the ledger would end up 60.00 in the borrower's
   * favour with two audit rows that both look correct. So the transaction opens
   * by taking a transaction-scoped advisory lock on the tenant being paid, and
   * only then sums and compares: the second caller waits, re-reads, and is
   * refused by the rule that already exists. The lock is released by commit or
   * rollback, never held by application code.
   */
  async recordPayout(input: RecordPayoutInput, operator: Operator) {
    await this.assertOperator(operator);

    if (!(input.amount.greaterThan(ZERO))) {
      throw new SettlementRefused('amount_not_positive', input.amount.toString());
    }

    const payout = await this.all.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PAYOUT_LOCK}::int, hashtext(${input.tenantId}::text))`;

      const outstanding = await this.outstandingFor(input.tenantId, tx);
      if (input.amount.greaterThan(outstanding)) {
        throw new SettlementRefused(
          'exceeds_outstanding',
          `${input.amount.toFixed(2)} > ${outstanding.toFixed(2)}`,
        );
      }

      const created = await tx.gatewaySettlementPayout.create({
        data: {
          tenantId: input.tenantId,
          amount: input.amount,
          currencyCode: await operatingCurrencyOf(tx, input.tenantId),
          recordedByAdminId: operator.adminId,
          method: input.method ?? null,
          reference: input.reference ?? null,
          proofAttachmentKey: input.proofAttachmentKey ?? null,
          notes: input.notes ?? null,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: input.tenantId,
          adminId: operator.adminId,
          action: 'gateway_settlement_payout',
          targetEntityType: 'settlement_payout',
          targetEntityId: created.id,
          oldValue: { outstanding: outstanding.toFixed(2) },
          newValue: {
            amount: input.amount.toFixed(2),
            outstanding: outstanding.minus(input.amount).toFixed(2),
            method: input.method ?? null,
            reference: input.reference ?? null,
            proofAttachmentKey: input.proofAttachmentKey ?? null,
          },
          adminIpAddress: operator.ip,
        },
      });
      return created;
    });

    this.logger.log(
      `payout ${payout.id} of ${input.amount.toFixed(2)} to ${input.tenantId} by ${operator.adminId}`,
    );
    return payout;
  }
}
