import { Injectable, Logger } from '@nestjs/common';
import {
  AdminAction,
  AuditTargetType,
  Prisma,
  TenantBillingReasonType,
  TenantLedgerDirection,
  TenantType,
} from '@prisma/client';
import {
  TenantBillingDuplicateEntry,
  TenantBillingInsufficientBalance,
  TenantBillingInvalidAmount,
  TenantBillingLedger,
  TenantBillingVersionConflict,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The platform owner credits or debits a reseller's billing wallet by hand
 * (F-019-a, D-41): a bank transfer received off-platform, a correction.
 *
 * **Only the platform owner.** A reseller never adjusts its own balance — it
 * tops up (F-019-b) and is charged (F-019-c). The owner writes another
 * tenant's row, which that row's strict RLS refuses on the app pool, so the
 * owner is served on the cross-tenant pool and nobody else reaches it
 * (ADR-0053): {@link access} reads the caller on the app pool and refuses a
 * non-owner before {@link all} is touched.
 *
 * **One request, one entry.** The client sends a `requestId` (uuid), which is
 * the entry's `referenceId`; the same request again is `duplicate_request`,
 * so a double submit cannot move the balance twice.
 *
 * The ledger entry and its `admin_audit_log` row commit together.
 */

export type TenantBillingActor = { adminId: string; tenantId: string; ip: string };

export type AdjustInput = {
  direction: 'credit' | 'debit';
  /** Base currency (C-02), a decimal string. */
  amount: string;
  /** The client's id for this act; the ledger entry's `referenceId`. */
  requestId: string;
  /** Why, for the audit trail. Never shown to the reseller. */
  note?: string;
};

export type AdjustmentView = {
  transactionId: string;
  tenantId: string;
  direction: TenantLedgerDirection;
  amount: string;
  balanceAfter: string;
  createdAt: Date;
};

/** Why an adjustment was refused. Closed — the controller gives each a status. */
export type TenantBillingAdminRejection =
  | 'not_platform_owner'
  | 'tenant_not_found'
  | 'not_a_reseller'
  | 'invalid_amount'
  | 'insufficient_balance'
  | 'duplicate_request'
  | 'wallet_changed';

export class TenantBillingAdminRefused extends Error {
  constructor(
    readonly reason: TenantBillingAdminRejection,
    detail = '',
  ) {
    super(`tenant billing refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantBillingAdminRefused';
  }
}

@Injectable()
export class TenantBillingAdminService {
  private readonly logger = new Logger(TenantBillingAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly ledger: TenantBillingLedger,
  ) {}

  async adjust(actor: TenantBillingActor, tenantId: string, input: AdjustInput): Promise<AdjustmentView> {
    await this.access(actor);

    const target = await this.all.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    if (!target) throw new TenantBillingAdminRefused('tenant_not_found', tenantId);
    if (target.tenantType !== TenantType.reseller) throw new TenantBillingAdminRefused('not_a_reseller', tenantId);

    const amount = parseAmount(input.amount);
    const entry = { tenantId, amount, reasonType: TenantBillingReasonType.admin_manual_adjust, referenceId: input.requestId };

    try {
      const row = await this.all.$transaction(async (tx) => {
        const moved =
          input.direction === 'credit' ? await this.ledger.credit(tx, entry) : await this.ledger.debit(tx, entry);
        const view = toView(tenantId, moved);
        await tx.adminAuditLog.create({
          data: {
            tenantId,
            adminId: actor.adminId,
            action: AdminAction.tenant_billing_adjust,
            targetEntityType: AuditTargetType.tenant_billing_wallet,
            targetEntityId: moved.walletId,
            newValue: { ...JSON.parse(JSON.stringify(view)), note: input.note ?? null } as Prisma.InputJsonValue,
            adminIpAddress: actor.ip,
          },
        });
        return view;
      });
      this.logger.log(`tenant ${tenantId} billing ${row.direction} ${row.amount} by ${actor.adminId}`);
      return row;
    } catch (e) {
      throw refusalOf(e);
    }
  }

  /** The one owner check; a non-owner is refused before the cross-tenant pool is touched (ADR-0053). */
  private async access(actor: TenantBillingActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new TenantBillingAdminRefused('not_platform_owner', "another tenant's billing wallet");
    }
  }
}

function parseAmount(raw: string): Prisma.Decimal {
  try {
    return new Prisma.Decimal(raw);
  } catch {
    throw new TenantBillingAdminRefused('invalid_amount', raw);
  }
}

function toView(
  tenantId: string,
  row: { id: string; direction: TenantLedgerDirection; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; createdAt: Date },
): AdjustmentView {
  return {
    transactionId: row.id,
    tenantId,
    direction: row.direction,
    amount: row.amount.toString(),
    balanceAfter: row.balanceAfter.toString(),
    createdAt: row.createdAt,
  };
}

function refusalOf(e: unknown): unknown {
  if (e instanceof TenantBillingInvalidAmount) return new TenantBillingAdminRefused('invalid_amount');
  if (e instanceof TenantBillingInsufficientBalance) return new TenantBillingAdminRefused('insufficient_balance');
  if (e instanceof TenantBillingDuplicateEntry) return new TenantBillingAdminRefused('duplicate_request', e.referenceId);
  if (e instanceof TenantBillingVersionConflict) return new TenantBillingAdminRefused('wallet_changed');
  return e;
}
