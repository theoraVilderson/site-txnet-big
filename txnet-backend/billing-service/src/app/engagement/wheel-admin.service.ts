import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, SpinPrizeType } from '@prisma/client';
import { TenantContext, operatingCurrencyOf, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { missingPrizeRelation, prizeShapeOk } from './prize-shape';
import { addDays, isoDay, tenantDayOf, tenantZoneOf } from './tenant-day';

/**
 * A tenant's wheel settings (F-707-c, ADR-0111 point 4):
 * `/api/billing/engagement/wheel`.
 *
 * **A save is a new version, never an edit.** It takes effect from the
 * tenant's next calendar day (TZ-1), so a day half spun keeps the odds and the
 * cap it started with; the version in force on a day is the highest one whose
 * `effectiveFromDay` is not after it. Two saves on one day: the later wins
 * tomorrow, and the earlier is history that never ran. The database holds the
 * same rule (`spin_wheel_is_history`); this answers it with a reason.
 *
 * **The cap is checked against the odds.** A version whose expected cost per
 * spin — Σ weight × cost / Σ weight — is over the day's cap is refused: it
 * would turn the day into `empty` slots after the first spin or two, and the
 * odds shown to users would not be the odds they get. A prize costing more
 * than the whole cap could never be given, and is refused too.
 *
 * Every row is the caller's own tenant's (RLS); a coupon template, a variant
 * and a user group must be ones it can see. No cash (point 2).
 */

export type WheelAdminRejection =
  | 'invalid_prize'
  | 'invalid_amount'
  | 'expected_cost_over_cap'
  | 'prize_cost_over_cap'
  | 'coupon_template_not_found'
  | 'variant_not_found'
  | 'group_not_found'
  | 'version_not_found'
  | 'version_taken';

export class WheelAdminRefused extends Error {
  constructor(
    readonly reason: WheelAdminRejection,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'WheelAdminRefused';
  }
}

export type WheelActor = { adminId: string; tenantId: string; ip: string };

export type WheelPrizeInput = {
  label: string;
  prizeType: SpinPrizeType;
  /** A decimal string (C-02): GB, whole days, or a coupon's percent; 0 for a free Grant or an empty slot. */
  prizeValue: string;
  couponTemplateId?: string | null;
  couponValidDays?: number | null;
  variantId?: string | null;
  weight: number;
  /** What an award spends of the day's cap, in the tenant's currency. */
  costAmount: string;
  /** Awards a day; null = no stock limit. */
  dailyStockLimit?: number | null;
};

export type WheelVersionInput = {
  isActive?: boolean;
  dailyBudgetCapAmount: string;
  perUserCooldownHours?: number;
  maxSpinsPerAccountPerDay?: number;
  requiresMinAccountAgeHours?: number;
  requiresMinTotalPurchaseAmount?: string | null;
  requiresMinCompletedOrdersCount?: number | null;
  requiresActiveServiceAtSpinTime?: boolean;
  requiresPhoneVerified?: boolean;
  userGroupId?: string | null;
  /** In slot order: the first is position 1. */
  prizes: WheelPrizeInput[];
};

export type WheelPrizeView = {
  id: string;
  position: number;
  label: string;
  prizeType: SpinPrizeType;
  prizeValue: string;
  couponTemplateId: string | null;
  couponValidDays: number | null;
  variantId: string | null;
  weight: number;
  costAmount: string;
  dailyStockLimit: number | null;
};

export type WheelVersionView = {
  id: string;
  version: number;
  effectiveFromDay: string;
  isActive: boolean;
  dailyBudgetCapAmount: string;
  currencyCode: string;
  perUserCooldownHours: number;
  maxSpinsPerAccountPerDay: number;
  requiresMinAccountAgeHours: number;
  requiresMinTotalPurchaseAmount: string | null;
  requiresMinCompletedOrdersCount: number | null;
  requiresActiveServiceAtSpinTime: boolean;
  requiresPhoneVerified: boolean;
  userGroupId: string | null;
  createdByAdminId: string;
  createdAt: Date;
  /** Σ weight × cost / Σ weight, to the cent: what a spin costs on average. */
  expectedCostPerSpin: string;
  prizes: WheelPrizeView[];
};

export type WheelState = {
  /** The tenant's calendar day now. */
  today: string;
  inForce: WheelVersionView | null;
  /** A version saved for a later day, if any: what tomorrow brings. */
  next: WheelVersionView | null;
  /** Every version, newest first. */
  history: WheelVersionView[];
};

type Tx = Prisma.TransactionClient;
type PrizeRow = {
  id: string;
  position: number;
  label: string;
  prizeType: SpinPrizeType;
  prizeValue: Prisma.Decimal;
  couponTemplateId: string | null;
  couponValidDays: number | null;
  variantId: string | null;
  probabilityWeight: number;
  costAmount: Prisma.Decimal;
  dailyStockLimit: number | null;
};
type ConfigRow = {
  id: string;
  version: number;
  effectiveFromDay: Date;
  isActive: boolean;
  dailyBudgetCapAmount: Prisma.Decimal;
  currencyCode: string;
  perUserCooldownHours: number;
  maxSpinsPerAccountPerDay: number;
  requiresMinAccountAgeHours: number;
  requiresMinTotalPurchaseAmount: Prisma.Decimal | null;
  requiresMinCompletedOrdersCount: number | null;
  requiresActiveServiceAtSpinTime: boolean;
  requiresPhoneVerified: boolean;
  userGroupId: string | null;
  createdByAdminId: string;
  createdAt: Date;
  prizes: PrizeRow[];
};

/** The clock, injectable so a spec can stand on a tenant's midnight. */
export const WHEEL_CLOCK = Symbol('WHEEL_CLOCK');

/** Σ weight × cost / Σ weight. */
export function expectedCostPerSpin(prizes: Array<{ weight: number; cost: Prisma.Decimal }>): Prisma.Decimal {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  if (total === 0) return new Prisma.Decimal(0);
  return prizes.reduce((s, p) => s.add(p.cost.mul(p.weight)), new Prisma.Decimal(0)).div(total);
}

function decimal(v: string, reason: WheelAdminRejection = 'invalid_prize'): Prisma.Decimal {
  try {
    const d = new Prisma.Decimal(v);
    if (d.isNegative() || d.decimalPlaces() > 2) throw new Error();
    return d;
  } catch {
    throw new WheelAdminRefused(reason, v);
  }
}

/** The shape the database's `engagement.prize_shape_ok` holds, answered with a reason instead of a 500. */
function checkPrize(p: WheelPrizeInput, value: Prisma.Decimal, cost: Prisma.Decimal): void {
  const ok = prizeShapeOk({ ...p, prizeValue: value }) && (p.prizeType !== SpinPrizeType.empty || cost.isZero());
  if (!ok || !Number.isInteger(p.weight) || p.weight < 1) throw new WheelAdminRefused('invalid_prize', `${p.prizeType} "${p.label}"`);
}

function viewOf(row: ConfigRow): WheelVersionView {
  const prizes = [...row.prizes].sort((a, b) => a.position - b.position);
  return {
    id: row.id,
    version: row.version,
    effectiveFromDay: isoDay(row.effectiveFromDay),
    isActive: row.isActive,
    dailyBudgetCapAmount: new Prisma.Decimal(row.dailyBudgetCapAmount).toFixed(2),
    currencyCode: row.currencyCode,
    perUserCooldownHours: row.perUserCooldownHours,
    maxSpinsPerAccountPerDay: row.maxSpinsPerAccountPerDay,
    requiresMinAccountAgeHours: row.requiresMinAccountAgeHours,
    requiresMinTotalPurchaseAmount: row.requiresMinTotalPurchaseAmount === null ? null : new Prisma.Decimal(row.requiresMinTotalPurchaseAmount).toFixed(2),
    requiresMinCompletedOrdersCount: row.requiresMinCompletedOrdersCount,
    requiresActiveServiceAtSpinTime: row.requiresActiveServiceAtSpinTime,
    requiresPhoneVerified: row.requiresPhoneVerified,
    userGroupId: row.userGroupId,
    createdByAdminId: row.createdByAdminId,
    createdAt: row.createdAt,
    expectedCostPerSpin: expectedCostPerSpin(prizes.map((p) => ({ weight: p.probabilityWeight, cost: new Prisma.Decimal(p.costAmount) }))).toFixed(2),
    prizes: prizes.map((p) => ({
      id: p.id,
      position: p.position,
      label: p.label,
      prizeType: p.prizeType,
      prizeValue: new Prisma.Decimal(p.prizeValue).toFixed(2),
      couponTemplateId: p.couponTemplateId,
      couponValidDays: p.couponValidDays,
      variantId: p.variantId,
      weight: p.probabilityWeight,
      costAmount: new Prisma.Decimal(p.costAmount).toFixed(2),
      dailyStockLimit: p.dailyStockLimit,
    })),
  };
}

/** The version in force on `day`: the highest whose first day is not after it. */
export function versionOn<T extends { version: number; effectiveFromDay: Date }>(versions: T[], day: Date): T | null {
  return versions.filter((v) => v.effectiveFromDay.getTime() <= day.getTime()).sort((a, b) => b.version - a.version)[0] ?? null;
}

const WITH_PRIZES = { prizes: true } as const;

@Injectable()
export class WheelAdminService {
  private readonly logger = new Logger(WheelAdminService.name);
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WHEEL_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  state(actor: WheelActor): Promise<WheelState> {
    return tenantTransaction(this.prisma, async (tx) => {
      const today = tenantDayOf(this.now(), await tenantZoneOf(tx, actor.tenantId));
      const rows = (await tx.spinWheelConfig.findMany({ where: { tenantId: actor.tenantId }, include: WITH_PRIZES, orderBy: { version: 'desc' } })) as ConfigRow[];
      const inForce = versionOn(rows, today);
      const later = rows.filter((v) => v.effectiveFromDay.getTime() > today.getTime());
      const next = versionOn(later, addDays(today, 1));
      return { today: isoDay(today), inForce: inForce && viewOf(inForce), next: next && viewOf(next), history: rows.map(viewOf) };
    });
  }

  save(actor: WheelActor, input: WheelVersionInput): Promise<WheelVersionView> {
    const tenant = TenantContext.current('wheel version save');
    return tenantTransaction(this.prisma, async (tx) => {
      const cap = decimal(input.dailyBudgetCapAmount, 'invalid_amount');
      const prizes = input.prizes.map((p) => {
        const value = decimal(p.prizeValue);
        const cost = decimal(p.costAmount);
        checkPrize(p, value, cost);
        return { p, value, cost };
      });
      if (expectedCostPerSpin(prizes.map(({ p, cost }) => ({ weight: p.weight, cost }))).gt(cap)) {
        throw new WheelAdminRefused('expected_cost_over_cap', cap.toFixed(2));
      }
      const tooDear = prizes.find(({ cost }) => cost.gt(cap));
      if (tooDear) throw new WheelAdminRefused('prize_cost_over_cap', tooDear.p.label);
      await this.checkRelations(tx, tenant.id, input);

      const today = tenantDayOf(this.now(), await tenantZoneOf(tx, tenant.id));
      const last = await tx.spinWheelConfig.findFirst({ where: { tenantId: tenant.id }, orderBy: { version: 'desc' }, select: { version: true } });
      const minTotal = input.requiresMinTotalPurchaseAmount ? decimal(input.requiresMinTotalPurchaseAmount, 'invalid_amount') : null;
      let config: { id: string };
      try {
        config = await tx.spinWheelConfig.create({
          data: {
            tenantId: tenant.id,
            version: (last?.version ?? 0) + 1,
            effectiveFromDay: addDays(today, 1),
            isActive: input.isActive ?? true,
            dailyBudgetCapAmount: cap.toFixed(2),
            currencyCode: await operatingCurrencyOf(tx, tenant.id),
            perUserCooldownHours: input.perUserCooldownHours ?? 24,
            maxSpinsPerAccountPerDay: input.maxSpinsPerAccountPerDay ?? 1,
            requiresMinAccountAgeHours: input.requiresMinAccountAgeHours ?? 24,
            requiresMinTotalPurchaseAmount: minTotal?.toFixed(2) ?? null,
            requiresMinCompletedOrdersCount: input.requiresMinCompletedOrdersCount ?? null,
            requiresActiveServiceAtSpinTime: input.requiresActiveServiceAtSpinTime ?? true,
            requiresPhoneVerified: input.requiresPhoneVerified ?? true,
            userGroupId: input.userGroupId ?? null,
            createdByAdminId: actor.adminId,
          },
          select: { id: true },
        });
      } catch (e) {
        // Two saves racing for one number: the unique (tenant, version) picks one.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new WheelAdminRefused('version_taken');
        throw e;
      }
      // In the version's own transaction: the database refuses a prize added later.
      await tx.spinWheelPrize.createMany({
        data: prizes.map(({ p, value, cost }, i) => ({
          tenantId: tenant.id,
          wheelConfigId: config.id,
          position: i + 1,
          label: p.label,
          prizeType: p.prizeType,
          prizeValue: value.toFixed(2),
          couponTemplateId: p.couponTemplateId ?? null,
          couponValidDays: p.couponValidDays ?? null,
          variantId: p.variantId ?? null,
          probabilityWeight: p.weight,
          costAmount: cost.toFixed(2),
          dailyStockLimit: p.dailyStockLimit ?? null,
        })),
      });

      const rows = (await tx.spinWheelConfig.findMany({ where: { tenantId: tenant.id, id: config.id }, include: WITH_PRIZES })) as ConfigRow[];
      const view = viewOf(rows.find((r) => r.id === config.id) as ConfigRow);
      const { id: _id, createdAt: _c, prizes: savedPrizes, ...rest } = view;
      await tx.adminAuditLog.create({
        data: {
          tenantId: tenant.id,
          adminId: actor.adminId,
          action: 'spin_wheel_version_create',
          targetEntityType: 'spin_wheel_config',
          targetEntityId: config.id,
          oldValue: Prisma.DbNull,
          newValue: { ...rest, prizes: savedPrizes.map(({ id: _p, ...p }) => p) } as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      this.logger.log(`wheel version ${view.version} saved by ${actor.adminId}, from ${view.effectiveFromDay}`);
      return view;
    });
  }

  version(actor: WheelActor, version: number): Promise<WheelVersionView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = (await tx.spinWheelConfig.findMany({ where: { tenantId: actor.tenantId, version }, include: WITH_PRIZES })) as ConfigRow[];
      const row = rows.find((r) => r.version === version);
      if (!row) throw new WheelAdminRefused('version_not_found', String(version));
      return viewOf(row);
    });
  }

  /** A template, a variant and a group must be ones this tenant can see (RLS: another's is not found). */
  private async checkRelations(tx: Tx, tenantId: string, input: WheelVersionInput): Promise<void> {
    const missing = await missingPrizeRelation(tx, tenantId, input.prizes);
    if (missing) throw new WheelAdminRefused(missing.reason, missing.id);
    if (input.userGroupId) {
      const g = await tx.userGroup.findUnique({ where: { id: input.userGroupId }, select: { id: true } });
      if (!g) throw new WheelAdminRefused('group_not_found', input.userGroupId);
    }
  }
}
