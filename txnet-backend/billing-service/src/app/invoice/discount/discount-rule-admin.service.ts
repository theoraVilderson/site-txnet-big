import { Injectable, Logger } from '@nestjs/common';
import { DiscountRuleKind, Prisma } from '@prisma/client';
import { TenantContext, tenantTransaction, operatingCurrencyOf } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Managing discounts with no code (F-114-h, D-45, ADR-0087):
 * `/api/billing/discount-rules`.
 *
 * **A rule is its tenant's alone**, the platform owner's included: every
 * query runs in the caller's `tenantTransaction`, so RLS is the boundary and
 * there is no cross-tenant pool here (unlike coupons, ADR-0053 — a platform
 * rule serving other tenants' users is not a thing). The product or category a
 * rule covers must be one the tenant can see (its own or the platform's), and
 * a named user one of its own, and a group (F-114-j) one of its own — the
 * composite foreign key refuses any other as well.
 *
 * A rule an invoice names is never deleted (the invoice's foreign key is
 * RESTRICT): it is switched off. Changing one changes only invoices made
 * after — an invoice records what its rule took.
 */

export type DiscountRuleRejection =
  | 'rule_not_found'
  | 'target_not_found'
  | 'user_out_of_scope'
  | 'invalid_value'
  | 'invalid_window'
  | 'one_target'
  | 'named_needs_users'
  | 'one_audience'
  | 'group_not_found';

export class DiscountRuleRefused extends Error {
  constructor(
    readonly reason: DiscountRuleRejection,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'DiscountRuleRefused';
  }
}

export type DiscountRuleActor = { adminId: string; tenantId: string; ip: string };

export type DiscountRuleInput = {
  name: string;
  kind: DiscountRuleKind;
  /** A decimal string (C-02): a percentage in (0, 100], or an amount in base currency. */
  value: string;
  productId?: string | null;
  categoryId?: string | null;
  forNamedUsers?: boolean;
  userIds?: string[];
  /** One user group of this tenant (F-114-j); never with `forNamedUsers`. */
  groupId?: string | null;
  startsAt: string;
  endsAt?: string | null;
  isActive?: boolean;
};

export type DiscountRulePatch = Partial<DiscountRuleInput>;

/** What an admin sees at a glance; the first that holds wins. */
export type DiscountRuleStatus = 'off' | 'ended' | 'scheduled' | 'running';

export type DiscountRuleView = {
  id: string;
  name: string;
  kind: DiscountRuleKind;
  value: string;
  productId: string | null;
  categoryId: string | null;
  forNamedUsers: boolean;
  userIds: string[];
  groupId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  status: DiscountRuleStatus;
  createdAt: Date;
  updatedAt: Date;
};

type Tx = Prisma.TransactionClient;

type Merged = {
  name: string;
  kind: DiscountRuleKind;
  value: Prisma.Decimal;
  productId: string | null;
  categoryId: string | null;
  forNamedUsers: boolean;
  userIds: string[];
  groupId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
};

type RuleRow = Omit<Merged, 'userIds'> & { id: string; createdAt: Date; updatedAt: Date };

export function statusOfRule(r: { isActive: boolean; startsAt: Date; endsAt: Date | null }, now: number): DiscountRuleStatus {
  if (!r.isActive) return 'off';
  if (r.endsAt && r.endsAt.getTime() <= now) return 'ended';
  if (r.startsAt.getTime() > now) return 'scheduled';
  return 'running';
}

function viewOf(row: RuleRow, userIds: string[], now = Date.now()): DiscountRuleView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    value: row.value.toFixed(2),
    productId: row.productId,
    categoryId: row.categoryId,
    forNamedUsers: row.forNamedUsers,
    userIds,
    groupId: row.groupId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isActive: row.isActive,
    status: statusOfRule(row, now),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** What an audit row compares: the rule without its clocks. */
function snapshot(v: DiscountRuleView): Record<string, unknown> {
  const { id: _id, status: _status, createdAt: _c, updatedAt: _u, ...rest } = v;
  return { ...rest, startsAt: v.startsAt.toISOString(), endsAt: v.endsAt ? v.endsAt.toISOString() : null };
}

/** The shape rules the database also holds (CHECKs), answered here with a reason instead of a 500. */
function checkShape(m: Merged): void {
  if (m.value.decimalPlaces() > 2 || m.value.lte(0)) throw new DiscountRuleRefused('invalid_value');
  if (m.kind === DiscountRuleKind.percentage && m.value.gt(100)) throw new DiscountRuleRefused('invalid_value');
  if (m.productId !== null && m.categoryId !== null) throw new DiscountRuleRefused('one_target');
  if (Number.isNaN(m.startsAt.getTime()) || (m.endsAt && (Number.isNaN(m.endsAt.getTime()) || m.endsAt.getTime() <= m.startsAt.getTime()))) {
    throw new DiscountRuleRefused('invalid_window');
  }
  if (m.forNamedUsers && m.userIds.length === 0) throw new DiscountRuleRefused('named_needs_users');
  if (m.forNamedUsers && m.groupId !== null) throw new DiscountRuleRefused('one_audience');
}

function decimal(v: string): Prisma.Decimal {
  try {
    return new Prisma.Decimal(v);
  } catch {
    throw new DiscountRuleRefused('invalid_value');
  }
}

@Injectable()
export class DiscountRuleAdminService {
  private readonly logger = new Logger(DiscountRuleAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  list(_actor: DiscountRuleActor): Promise<DiscountRuleView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.discountRule.findMany({ include: { users: { select: { userId: true } } }, orderBy: { createdAt: 'desc' } });
      return rows.map((r) => viewOf(r, r.users.map((u) => u.userId)));
    });
  }

  create(actor: DiscountRuleActor, input: DiscountRuleInput): Promise<DiscountRuleView> {
    const tenant = TenantContext.current('discount rule create');
    return tenantTransaction(this.prisma, async (tx) => {
      const m: Merged = {
        name: input.name,
        kind: input.kind,
        value: decimal(input.value),
        productId: input.productId ?? null,
        categoryId: input.categoryId ?? null,
        forNamedUsers: input.forNamedUsers ?? false,
        userIds: [...new Set(input.userIds ?? [])],
        groupId: input.groupId ?? null,
        startsAt: new Date(input.startsAt),
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        isActive: input.isActive ?? true,
      };
      checkShape(m);
      await this.checkRelations(tx, tenant.id, m, { target: true, users: true, group: true });

      const { userIds, ...columns } = m;
      const row = await tx.discountRule.create({ data: { ...columns, tenantId: tenant.id, currencyCode: await operatingCurrencyOf(tx, tenant.id), createdByAdminId: actor.adminId } });
      if (m.forNamedUsers) {
        await tx.discountRuleUser.createMany({ data: userIds.map((userId) => ({ ruleId: row.id, userId, tenantId: tenant.id })) });
      }
      const view = viewOf(row, m.forNamedUsers ? userIds : []);
      await this.audit(tx, actor, tenant.id, 'discount_rule_create', view.id, null, view);
      this.logger.log(`discount rule ${view.id} created by ${actor.adminId}`);
      return view;
    });
  }

  update(actor: DiscountRuleActor, id: string, patch: DiscountRulePatch): Promise<DiscountRuleView> {
    const tenant = TenantContext.current('discount rule update');
    return tenantTransaction(this.prisma, async (tx) => {
      const row = await tx.discountRule.findUnique({ where: { id }, include: { users: { select: { userId: true } } } });
      if (!row) throw new DiscountRuleRefused('rule_not_found', id);
      const before = viewOf(row, row.users.map((u) => u.userId));

      const m: Merged = {
        name: patch.name ?? row.name,
        kind: patch.kind ?? row.kind,
        value: patch.value !== undefined ? decimal(patch.value) : row.value,
        productId: patch.productId !== undefined ? patch.productId : row.productId,
        categoryId: patch.categoryId !== undefined ? patch.categoryId : row.categoryId,
        forNamedUsers: patch.forNamedUsers ?? row.forNamedUsers,
        userIds: patch.userIds !== undefined ? [...new Set(patch.userIds)] : before.userIds,
        groupId: patch.groupId !== undefined ? patch.groupId : row.groupId,
        startsAt: patch.startsAt !== undefined ? new Date(patch.startsAt) : row.startsAt,
        endsAt: patch.endsAt !== undefined ? (patch.endsAt ? new Date(patch.endsAt) : null) : row.endsAt,
        isActive: patch.isActive ?? row.isActive,
      };
      checkShape(m);
      await this.checkRelations(tx, tenant.id, m, {
        target: patch.productId !== undefined || patch.categoryId !== undefined,
        users: patch.userIds !== undefined,
        group: patch.groupId !== undefined,
      });

      const { userIds, ...columns } = m;
      const updated = await tx.discountRule.update({ where: { id }, data: columns });
      const kept = m.forNamedUsers ? userIds : [];
      if (patch.userIds !== undefined || patch.forNamedUsers !== undefined) {
        await tx.discountRuleUser.deleteMany({ where: { ruleId: id } });
        if (kept.length > 0) await tx.discountRuleUser.createMany({ data: kept.map((userId) => ({ ruleId: id, userId, tenantId: tenant.id })) });
      }
      const view = viewOf(updated, kept);
      await this.audit(tx, actor, tenant.id, 'discount_rule_update', id, before, view);
      return view;
    });
  }

  /** The product or category is one this tenant can see and not archived; a named user and a group are this tenant's. */
  private async checkRelations(tx: Tx, tenantId: string, m: Merged, check: { target: boolean; users: boolean; group: boolean }): Promise<void> {
    if (check.target && m.productId !== null) {
      const p = await tx.product.findFirst({ where: { id: m.productId, archivedAt: null }, select: { id: true } });
      if (!p) throw new DiscountRuleRefused('target_not_found', m.productId);
    }
    if (check.target && m.categoryId !== null) {
      const c = await tx.productCategory.findFirst({ where: { id: m.categoryId, archivedAt: null }, select: { id: true } });
      if (!c) throw new DiscountRuleRefused('target_not_found', m.categoryId);
    }
    if (check.group && m.groupId !== null) {
      // RLS: another tenant's group is not found, as one that never existed.
      const g = await tx.userGroup.findUnique({ where: { id: m.groupId }, select: { id: true } });
      if (!g) throw new DiscountRuleRefused('group_not_found', m.groupId);
    }
    if (check.users && m.userIds.length > 0) {
      const users = await tx.user.findMany({ where: { id: { in: m.userIds } }, select: { id: true, tenantId: true } });
      for (const userId of m.userIds) {
        const u = users.find((x) => x.id === userId);
        if (!u || u.tenantId !== tenantId) throw new DiscountRuleRefused('user_out_of_scope', userId);
      }
    }
  }

  private async audit(
    tx: Tx,
    actor: DiscountRuleActor,
    tenantId: string,
    action: 'discount_rule_create' | 'discount_rule_update',
    id: string,
    before: DiscountRuleView | null,
    after: DiscountRuleView,
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        tenantId,
        adminId: actor.adminId,
        action,
        targetEntityType: 'discount_rule',
        targetEntityId: id,
        oldValue: before ? (snapshot(before) as Prisma.InputJsonValue) : Prisma.DbNull,
        newValue: snapshot(after) as Prisma.InputJsonValue,
        adminIpAddress: actor.ip,
      },
    });
  }
}
