import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, EntitlementSource, Prisma, TenantBillingModel, TenantStatus, TenantSuspensionCause, TenantType } from '@prisma/client';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { renewalDeadline } from '../renewal/tenant-renewal.service';
import { applyTenantStatus } from '../status/tenant-status.transition';
import { lockPackage, replacePackageEntitlements } from '../packages/package-entitlements';
import type { GrantGraceInput, PutSubscriptionInput, UpdateSubscriptionSettingsInput } from './tenant-subscription.schema';

/**
 * The platform owner puts a reseller on a package and period, and sets the
 * platform's trial length (F-018-e).
 *
 * **Only the platform owner**, checked on the app pool before the
 * cross-tenant pool is touched (ADR-0053) — a reseller's subscription and
 * entitlements are another tenant's rows.
 *
 * **The first package starts the trial:** `currentPeriodEnd` = now +
 * `trialDays`. A later package or period change keeps `currentPeriodEnd`; the
 * new price is charged at that renewal (F-019-c). Nothing is charged here.
 *
 * **Entitlements follow the package.** In the same transaction, under locks
 * on the package (shared) and then the tenant row, the tenant's
 * `package_included` entitlements are replaced by the package's
 * `includedFeatureKeys` as read under that lock — so a concurrent package edit
 * (F-018-o) is either fully before or fully after. Entitlements from any other
 * source are untouched (`package-entitlements.ts`).
 *
 * **More time to pay** (F-019-g): `graceUntil` moves the renewal's suspension
 * deadline later and lifts a `non_payment` suspension at once. No money moves
 * and the period does not change — the reseller still owes it.
 */

export type TenantSubscriptionActor = { adminId: string; tenantId: string; ip: string };

export type SubscriptionView = {
  tenantId: string;
  packageId: string;
  packageName: string;
  billingModel: TenantBillingModel;
  currentPeriodEnd: Date;
  startedAt: Date;
  includedFeatureKeys: string[];
};

export type GraceView = {
  tenantId: string;
  currentPeriodEnd: Date;
  /** The renewal does not suspend before this. */
  graceUntil: Date;
  status: TenantStatus;
  suspensionCause: TenantSuspensionCause | null;
};

export type SubscriptionSettingsView = { trialDays: number; suspensionHoldDays: number; renewalGraceDays: number; quotaTimeZone: string };

export type TenantSubscriptionRejection =
  | 'not_platform_owner'
  | 'reseller_not_found'
  | 'reseller_terminated'
  | 'subscription_not_found'
  | 'package_not_found'
  | 'package_inactive'
  | 'package_not_sold_for_period';

export class TenantSubscriptionRefused extends Error {
  constructor(
    readonly reason: TenantSubscriptionRejection,
    detail = '',
  ) {
    super(`tenant subscription refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantSubscriptionRefused';
  }
}

/** The platform's one settings row (CHECK `id = 1`, migration `20260917001300_tenant_subscription`). */
const SETTINGS_ID = 1;
const DAY_MS = 86_400_000;
const SETTINGS = { trialDays: true, suspensionHoldDays: true, renewalGraceDays: true, quotaTimeZone: true } as const;

const PRICE_OF: Record<PutSubscriptionInput['billingModel'], 'monthlyPrice' | 'yearlyPrice'> = {
  subscription_monthly: 'monthlyPrice',
  subscription_yearly: 'yearlyPrice',
};

@Injectable()
export class TenantSubscriptionService {
  private readonly logger = new Logger(TenantSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async put(actor: TenantSubscriptionActor, tenantId: string, input: PutSubscriptionInput): Promise<SubscriptionView> {
    await this.access(actor);
    const reseller = await this.reseller(tenantId);
    if (reseller.status === TenantStatus.terminated) throw new TenantSubscriptionRefused('reseller_terminated', tenantId);

    const pkg = await this.all.tenantFeaturePackage.findUnique({
      where: { id: input.packageId },
      select: { id: true, name: true, monthlyPrice: true, yearlyPrice: true, includedFeatureKeys: true, isActive: true },
    });
    if (!pkg) throw new TenantSubscriptionRefused('package_not_found', input.packageId);
    if (pkg[PRICE_OF[input.billingModel]] === null) {
      throw new TenantSubscriptionRefused('package_not_sold_for_period', `${pkg.name} ${input.billingModel}`);
    }

    const view = await this.all.$transaction(async (tx) => {
      await lockPackage(tx, pkg.id, 'share');
      const locked = await tx.tenantFeaturePackage.findUnique({ where: { id: pkg.id }, select: { includedFeatureKeys: true } });
      const keys = (locked?.includedFeatureKeys ?? pkg.includedFeatureKeys) as string[];
      await tx.$queryRaw`SELECT id FROM "tenant"."tenant" WHERE id = ${tenantId}::uuid FOR UPDATE`;
      const current = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: { packageId: true, currentPeriodEnd: true, createdAt: true },
      });
      // A deactivated package keeps the subscribers it has (F-018-d) and takes no new ones.
      if (!pkg.isActive && current?.packageId !== pkg.id) throw new TenantSubscriptionRefused('package_inactive', pkg.name);

      const currentPeriodEnd = current ? current.currentPeriodEnd : new Date(Date.now() + (await this.trialDays()) * DAY_MS);
      const row = await tx.tenantSubscription.upsert({
        where: { tenantId },
        create: { tenantId, packageId: pkg.id, currentPeriodEnd },
        update: { packageId: pkg.id },
        select: { currentPeriodEnd: true, createdAt: true },
      });
      if (reseller.billingModel !== input.billingModel) {
        await tx.tenant.update({ where: { id: tenantId }, data: { billingModel: input.billingModel } });
      }
      await replacePackageEntitlements(tx, [tenantId], keys);
      const after: SubscriptionView = {
        tenantId,
        packageId: pkg.id,
        packageName: pkg.name,
        billingModel: input.billingModel,
        currentPeriodEnd: row.currentPeriodEnd,
        startedAt: row.createdAt,
        includedFeatureKeys: keys,
      };
      await tx.adminAuditLog.create({
        data: {
          tenantId,
          adminId: actor.adminId,
          action: AdminAction.tenant_subscription_set,
          targetEntityType: AuditTargetType.tenant,
          targetEntityId: tenantId,
          oldValue: current
            ? (JSON.parse(JSON.stringify({ packageId: current.packageId, billingModel: reseller.billingModel })) as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          newValue: JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      return after;
    });
    this.logger.log(`reseller ${tenantId} put on package ${pkg.id} (${input.billingModel}) by ${actor.adminId}`);
    return view;
  }

  async read(actor: TenantSubscriptionActor, tenantId: string): Promise<SubscriptionView> {
    await this.access(actor);
    const reseller = await this.reseller(tenantId);
    const row = await this.all.tenantSubscription.findUnique({
      where: { tenantId },
      select: { packageId: true, currentPeriodEnd: true, createdAt: true, package: { select: { name: true } } },
    });
    if (!row) throw new TenantSubscriptionRefused('subscription_not_found', tenantId);
    const entitlements = await this.all.tenantFeatureEntitlement.findMany({
      where: { tenantId, source: EntitlementSource.package_included },
      select: { featureKey: true },
    });
    return {
      tenantId,
      packageId: row.packageId,
      packageName: row.package.name,
      billingModel: reseller.billingModel,
      currentPeriodEnd: row.currentPeriodEnd,
      startedAt: row.createdAt,
      includedFeatureKeys: entitlements.map((e) => e.featureKey),
    };
  }

  /**
   * `graceUntil` = the latest of now, the renewal's own deadline and an earlier
   * `graceUntil`, plus `days` — so a grant never shortens the time already
   * given. One transaction under the tenant row's lock; a `non_payment`
   * suspension becomes `active` (a `manual` one is lifted only by hand); one
   * audit row; no ledger entry.
   */
  async grantGrace(actor: TenantSubscriptionActor, tenantId: string, input: GrantGraceInput, now = new Date()): Promise<GraceView> {
    await this.access(actor);
    const settings = await this.all.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: { renewalGraceDays: true } });
    if (!settings) throw new Error('tenant_subscription_setting row is missing — run the migrations');

    const view = await this.all.$transaction(async (tx) => {
      const [tenant] = await tx.$queryRaw<{ id: string; tenantType: TenantType; status: TenantStatus; suspensionCause: TenantSuspensionCause | null }[]>`
        SELECT id, "tenantType", status, "suspensionCause"
        FROM "tenant"."tenant"
        WHERE id = ${tenantId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!tenant || tenant.tenantType !== TenantType.reseller) throw new TenantSubscriptionRefused('reseller_not_found', tenantId);
      if (tenant.status === TenantStatus.terminated) throw new TenantSubscriptionRefused('reseller_terminated', tenantId);
      const sub = await tx.tenantSubscription.findUnique({ where: { tenantId }, select: { currentPeriodEnd: true, graceUntil: true } });
      if (!sub) throw new TenantSubscriptionRefused('subscription_not_found', tenantId);

      const deadline = renewalDeadline(sub.currentPeriodEnd, settings.renewalGraceDays, sub.graceUntil);
      const base = deadline > now ? deadline : now;
      const after = await tx.tenantSubscription.update({
        where: { tenantId },
        data: { graceUntil: new Date(base.getTime() + input.days * DAY_MS) },
        select: { currentPeriodEnd: true, graceUntil: true },
      });
      let status: TenantStatus = tenant.status;
      let suspensionCause = tenant.suspensionCause;
      if (status === TenantStatus.suspended && suspensionCause === TenantSuspensionCause.non_payment) {
        ({ status, suspensionCause } = await applyTenantStatus(tx, tenantId, {
          from: status,
          to: TenantStatus.active,
          reason: input.reason,
          actorUserId: actor.adminId,
          now,
        }));
      }
      const result: GraceView = { tenantId, currentPeriodEnd: after.currentPeriodEnd, graceUntil: after.graceUntil as Date, status, suspensionCause };
      await tx.adminAuditLog.create({
        data: {
          tenantId,
          adminId: actor.adminId,
          action: AdminAction.tenant_subscription_grace,
          targetEntityType: AuditTargetType.tenant,
          targetEntityId: tenantId,
          oldValue: JSON.parse(JSON.stringify({ graceUntil: sub.graceUntil, status: tenant.status, suspensionCause: tenant.suspensionCause })) as Prisma.InputJsonValue,
          newValue: JSON.parse(JSON.stringify({ ...result, days: input.days, reason: input.reason })) as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      return result;
    });
    this.logger.log(`reseller ${tenantId} given grace until ${view.graceUntil.toISOString()} by ${actor.adminId}`);
    return view;
  }

  async readSettings(actor: TenantSubscriptionActor): Promise<SubscriptionSettingsView> {
    await this.access(actor);
    const row = await this.all.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: SETTINGS });
    if (!row) throw new Error('tenant_subscription_setting row is missing — run the migrations');
    return row;
  }

  async updateSettings(actor: TenantSubscriptionActor, input: UpdateSubscriptionSettingsInput): Promise<SubscriptionSettingsView> {
    await this.access(actor);
    return this.all.$transaction(async (tx) => {
      const before = await tx.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: SETTINGS });
      if (!before) throw new Error('tenant_subscription_setting row is missing — run the migrations');
      const after = await tx.tenantSubscriptionSetting.update({
        where: { id: SETTINGS_ID },
        data: {
          trialDays: input.trialDays,
          suspensionHoldDays: input.suspensionHoldDays,
          renewalGraceDays: input.renewalGraceDays,
          quotaTimeZone: input.quotaTimeZone,
          updatedByUserId: actor.adminId,
        },
        select: SETTINGS,
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: actor.tenantId,
          adminId: actor.adminId,
          action: AdminAction.tenant_subscription_setting_update,
          targetEntityType: AuditTargetType.tenant_subscription_setting,
          // The setting is the platform's, so its row is addressed by the platform owner's tenant.
          targetEntityId: actor.tenantId,
          oldValue: before,
          newValue: after,
          adminIpAddress: actor.ip,
        },
      });
      return after;
    });
  }

  private async trialDays(): Promise<number> {
    const row = await this.all.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: { trialDays: true } });
    if (!row) throw new Error('tenant_subscription_setting row is missing — run the migrations');
    return row.trialDays;
  }

  private async reseller(id: string): Promise<{ id: string; status: TenantStatus; billingModel: TenantBillingModel }> {
    const row = await this.all.tenant.findFirst({
      where: { id, tenantType: TenantType.reseller, deletedAt: null },
      select: { id: true, status: true, billingModel: true },
    });
    if (!row) throw new TenantSubscriptionRefused('reseller_not_found', id);
    return row;
  }

  /** The platform owner's tenant — the same check as reseller administration. */
  private async access(actor: TenantSubscriptionActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new TenantSubscriptionRefused('not_platform_owner', 'subscription administration');
    }
  }
}
