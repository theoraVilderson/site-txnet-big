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
  platformCurrencyOf,
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
 *
 * The same owner check and the same pool serve {@link TenantBillingAdminService.history},
 * the owner's read of one reseller's ledger (F-019-j).
 */

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** The platform's currency as the wire carries it: two decimals, as a string (C-02). */
const money = (v: Prisma.Decimal) => v.toFixed(2);

export type TenantBillingActor = { adminId: string; tenantId: string; ip: string };

/** What the owner check needs. A read has no audit row, so it carries no `ip`. */
export type TenantBillingReader = Omit<TenantBillingActor, 'ip'>;

export type AdjustInput = {
  direction: 'credit' | 'debit';
  /** The platform's currency (C-02, ADR-0098 part 4), a decimal string. */
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
  /** The wallet's, which the ledger wrote the row in (F-116-h2). */
  currencyCode: string;
  createdAt: Date;
};

export type TenantLedgerQuery = { page?: number; pageSize?: number };

export type TenantLedgerRow = {
  id: string;
  direction: TenantLedgerDirection;
  reasonType: TenantBillingReasonType;
  /** The mover's own id for the entry — a request id, a payment, a charged period. */
  referenceId: string | null;
  /** The platform's currency (C-02, ADR-0098 part 4), two decimals, as a string. */
  amount: string;
  balanceAfter: string;
  /** What `amount` and `balanceAfter` are in: the row's own, the platform's when it was written (F-116-h2). */
  currencyCode: string;
  createdAt: Date;
};

export type TenantLedgerPage = {
  tenantId: string;
  balance: string;
  /** The wallet's currency — the platform's — or the platform's now for a reseller with no wallet yet (F-116-h2). */
  currencyCode: string;
  total: number;
  page: number;
  pageSize: number;
  rows: TenantLedgerRow[];
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
    await this.reseller(tenantId);

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

  /**
   * The platform owner reads one reseller's ledger (F-019-j): the balance and
   * its movements, newest first, for that reseller's page.
   *
   * The adjustment's door and the adjustment's pool — the caller is read on the
   * app pool and a non-owner refused before the cross-tenant pool is touched
   * (ADR-0053), because a reseller's own wallet is hidden from it by strict RLS
   * and every other reseller's is not.
   */
  async history(actor: TenantBillingReader, tenantId: string, query: TenantLedgerQuery): Promise<TenantLedgerPage> {
    await this.access(actor);
    await this.reseller(tenantId);

    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const wallet = await this.all.tenantBillingWallet.findUnique({
      where: { tenantId },
      select: { id: true, cachedBalance: true, currencyCode: true },
    });
    // A reseller that has never been credited has no wallet yet: a zero balance, as the ledger reads it.
    if (!wallet) return { tenantId, balance: '0.00', currencyCode: await platformCurrencyOf(this.all), total: 0, page, pageSize, rows: [] };

    const where = { walletId: wallet.id };
    const [rows, total] = await Promise.all([
      this.all.tenantBillingTransaction.findMany({
        where,
        // `id` breaks a timestamp tie, so a page never repeats or skips a row.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          amount: true,
          direction: true,
          reasonType: true,
          referenceId: true,
          balanceAfter: true,
          currencyCode: true,
          createdAt: true,
        },
      }),
      this.all.tenantBillingTransaction.count({ where }),
    ]);

    return {
      tenantId,
      // The wallet's own figure (invariant 3), never a sum of the rows on the page.
      balance: money(wallet.cachedBalance),
      currencyCode: wallet.currencyCode,
      total,
      page,
      pageSize,
      rows: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        reasonType: r.reasonType,
        referenceId: r.referenceId,
        amount: money(r.amount),
        balanceAfter: money(r.balanceAfter),
        currencyCode: r.currencyCode,
        createdAt: r.createdAt,
      })),
    };
  }

  /** The target of every surface here: a reseller that exists, never the platform owner itself. */
  private async reseller(tenantId: string): Promise<void> {
    const target = await this.all.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    if (!target) throw new TenantBillingAdminRefused('tenant_not_found', tenantId);
    if (target.tenantType !== TenantType.reseller) throw new TenantBillingAdminRefused('not_a_reseller', tenantId);
  }

  /** The one owner check; a non-owner is refused before the cross-tenant pool is touched (ADR-0053). */
  private async access(actor: TenantBillingReader): Promise<void> {
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
  row: { id: string; direction: TenantLedgerDirection; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; currencyCode: string; createdAt: Date },
): AdjustmentView {
  return {
    transactionId: row.id,
    tenantId,
    direction: row.direction,
    amount: row.amount.toString(),
    balanceAfter: row.balanceAfter.toString(),
    currencyCode: row.currencyCode,
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
