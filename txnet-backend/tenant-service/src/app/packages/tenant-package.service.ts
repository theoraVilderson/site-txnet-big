import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, TenantBillingModel, TenantStatus, TenantType } from '@prisma/client';
import { platformCurrencyOf } from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { addPackageEntitlements, lockPackage, lockSubscribers, replacePackageEntitlements } from './package-entitlements';
import { type MeterRateView, ratesOf, unknownMeters, writeMeterRates } from './package-meter-rates';
import type { CreatePackageInput, ListPackagesInput, MeterRateEdit, UpdatePackageInput } from './tenant-package.schema';

/**
 * The platform owner creates, edits, deactivates, lists and reads the
 * packages the platform sells resellers (F-018-d).
 *
 * **Only the platform owner**, checked before any package row is read.
 * `tenant_feature_package` has no `tenantId` and no RLS policy, so the app pool
 * serves it; the audit row carries the platform owner's own tenant.
 *
 * **Never deleted.** Deactivation is `isActive: false` and writes nothing else:
 * a package's current subscribers keep it until their next renewal (F-019-c
 * decides what a renewal on an inactive package does). Prices are
 * base-currency decimals (C-02); a package keeps at least one of its two.
 *
 * **Subscribers follow a feature change halfway (F-018-o).** A key added to
 * `includedFeatureKeys` is granted to every current subscriber in the edit's
 * transaction; a removed key stays until that subscriber's renewal (F-019-c),
 * because the period was paid for with it. {@link apply} forces the full list,
 * removals included, onto every subscriber at once. Both run on the
 * cross-tenant pool — the entitlements are the subscribers' rows.
 *
 * **The wholesale price list rides along (F-118-n1).** `meterRates` writes
 * `tenant_package_meter_rate` in the same transaction as the package and its
 * audit row (`package-meter-rates.ts`); the view shows the rates in force.
 */

export type TenantPackageActor = { adminId: string; tenantId: string; ip: string };

export type PackageApplyView = { packageId: string; includedFeatureKeys: string[]; subscribers: number };

export type PackageView = {
  id: string;
  name: string;
  monthlyPrice: string | null;
  yearlyPrice: string | null;
  /** What both prices are in: the package's own, the platform's (ADR-0098 part 4, F-116-h3). */
  currencyCode: string;
  includedFeatureKeys: string[];
  isActive: boolean;
  /** The wholesale rates in force, by meter key (F-118-n1), in `currencyCode`. */
  meterRates: MeterRateView[];
};

export type TenantPackageRejection = 'not_platform_owner' | 'package_not_found' | 'package_name_taken' | 'package_unpriced' | 'package_price_in_use' | 'meter_not_found';

export class TenantPackageRefused extends Error {
  constructor(
    readonly reason: TenantPackageRejection,
    detail = '',
  ) {
    super(`tenant package refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantPackageRefused';
  }
}

const PACKAGE_SELECT = {
  id: true,
  name: true,
  monthlyPrice: true,
  yearlyPrice: true,
  currencyCode: true,
  includedFeatureKeys: true,
  isActive: true,
} satisfies Prisma.TenantFeaturePackageSelect;

type PackageRow = Prisma.TenantFeaturePackageGetPayload<{ select: typeof PACKAGE_SELECT }>;

@Injectable()
export class TenantPackageService {
  private readonly logger = new Logger(TenantPackageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async create(actor: TenantPackageActor, input: CreatePackageInput): Promise<PackageView> {
    await this.access(actor);
    await this.nameFree(input.name);
    const view = await this.writing(input.name, () =>
      this.prisma.$transaction(async (tx) => {
        await this.metersKnown(tx, input.meterRates ?? []);
        const row = await tx.tenantFeaturePackage.create({
          data: {
            name: input.name,
            monthlyPrice: input.monthlyPrice ?? null,
            yearlyPrice: input.yearlyPrice ?? null,
            includedFeatureKeys: input.includedFeatureKeys,
            // Priced in the platform's currency (ADR-0098 part 4); converted with it (F-116-f).
            currencyCode: await platformCurrencyOf(tx),
          },
          select: PACKAGE_SELECT,
        });
        await writeMeterRates(tx, row, [], input.meterRates ?? [], actor.adminId);
        const created = toView(row, await this.ratesOne(tx, row));
        await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.tenant_package_create, created.id, null, created) });
        return created;
      }),
    );
    this.logger.log(`package ${view.id} (${view.name}) created by ${actor.adminId}`);
    return view;
  }

  /**
   * A price cleared while a subscriber that is not terminated renews on that
   * period is `package_price_in_use` (F-019-c): the renewal would have nothing
   * to charge. Checked under the package's `FOR UPDATE`, which a subscription
   * `PUT` waits on.
   */
  private async pricesStillSold(tx: Prisma.TransactionClient, id: string, before: PackageView, patch: UpdatePackageInput): Promise<void> {
    const cleared: TenantBillingModel[] = [];
    if (patch.monthlyPrice === null && before.monthlyPrice !== null) cleared.push(TenantBillingModel.subscription_monthly);
    if (patch.yearlyPrice === null && before.yearlyPrice !== null) cleared.push(TenantBillingModel.subscription_yearly);
    if (cleared.length === 0) return;
    const inUse = await tx.tenantSubscription.count({
      where: { packageId: id, tenant: { billingModel: { in: cleared }, status: { not: TenantStatus.terminated } } },
    });
    if (inUse > 0) throw new TenantPackageRefused('package_price_in_use', `${inUse} subscriber(s) on ${cleared.join(', ')}`);
  }

  async update(actor: TenantPackageActor, id: string, patch: UpdatePackageInput): Promise<PackageView> {
    await this.access(actor);
    const found = await this.find(id);
    const before = toView(found, await this.ratesOne(this.prisma, found));
    const monthly = patch.monthlyPrice === undefined ? before.monthlyPrice : patch.monthlyPrice;
    const yearly = patch.yearlyPrice === undefined ? before.yearlyPrice : patch.yearlyPrice;
    if (monthly === null && yearly === null) throw new TenantPackageRefused('package_unpriced', id);
    if (patch.name !== undefined && patch.name !== before.name) await this.nameFree(patch.name);

    const data: Prisma.TenantFeaturePackageUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.monthlyPrice !== undefined) data.monthlyPrice = patch.monthlyPrice;
    if (patch.yearlyPrice !== undefined) data.yearlyPrice = patch.yearlyPrice;
    if (patch.includedFeatureKeys !== undefined) data.includedFeatureKeys = patch.includedFeatureKeys;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    return this.writing(patch.name ?? before.name, () =>
      this.all.$transaction(async (tx) => {
        await lockPackage(tx, id, 'update');
        await this.pricesStillSold(tx, id, before, patch);
        await this.metersKnown(tx, patch.meterRates ?? []);
        const held = patch.includedFeatureKeys === undefined ? null : await tx.tenantFeaturePackage.findUnique({ where: { id }, select: { includedFeatureKeys: true } });
        const row = await tx.tenantFeaturePackage.update({ where: { id }, data, select: PACKAGE_SELECT });
        const repriced = await writeMeterRates(tx, row, before.meterRates, patch.meterRates ?? [], actor.adminId);
        const after = toView(row, await this.ratesOne(tx, row));
        if (held) {
          const had = new Set(held.includedFeatureKeys as string[]);
          const added = after.includedFeatureKeys.filter((k) => !had.has(k));
          if (added.length > 0) await addPackageEntitlements(tx, await lockSubscribers(tx, id), added);
        }
        const changed = Object.keys(data) as (keyof PackageView)[];
        if (repriced) changed.push('meterRates');
        await tx.adminAuditLog.create({
          data: this.audit(actor, AdminAction.tenant_package_update, id, pick(before, changed), pick(after, changed)),
        });
        return after;
      }),
    );
  }

  /** Every subscriber's `package_included` entitlements become the package's list now, removals included. */
  async apply(actor: TenantPackageActor, id: string): Promise<PackageApplyView> {
    await this.access(actor);
    await this.find(id);
    const view = await this.all.$transaction(async (tx) => {
      await lockPackage(tx, id, 'share');
      const row = await tx.tenantFeaturePackage.findUnique({ where: { id }, select: { includedFeatureKeys: true } });
      if (!row) throw new TenantPackageRefused('package_not_found', id);
      const includedFeatureKeys = row.includedFeatureKeys as string[];
      const subscribers = await lockSubscribers(tx, id);
      await replacePackageEntitlements(tx, subscribers, includedFeatureKeys);
      const result = { packageId: id, includedFeatureKeys, subscribers: subscribers.length };
      await tx.adminAuditLog.create({
        data: this.audit(actor, AdminAction.tenant_package_apply, id, null, { includedFeatureKeys, subscribers: subscribers.length, tenantIds: subscribers }),
      });
      return result;
    });
    this.logger.log(`package ${id} forced onto ${view.subscribers} subscriber(s) by ${actor.adminId}`);
    return view;
  }

  async list(actor: TenantPackageActor, query: ListPackagesInput): Promise<PackageView[]> {
    await this.access(actor);
    const rows = await this.prisma.tenantFeaturePackage.findMany({
      where: query.active === undefined ? {} : { isActive: query.active },
      orderBy: { name: 'asc' },
      select: PACKAGE_SELECT,
    });
    const rates = await ratesOf(this.prisma, rows);
    return rows.map((row) => toView(row, rates.get(row.id) ?? []));
  }

  async read(actor: TenantPackageActor, id: string): Promise<PackageView> {
    await this.access(actor);
    const row = await this.find(id);
    return toView(row, await this.ratesOne(this.prisma, row));
  }

  private async find(id: string): Promise<PackageRow> {
    const row = await this.prisma.tenantFeaturePackage.findUnique({ where: { id }, select: PACKAGE_SELECT });
    if (!row) throw new TenantPackageRefused('package_not_found', id);
    return row;
  }

  private async ratesOne(db: Pick<Prisma.TransactionClient, 'tenantPackageMeterRate'>, row: PackageRow): Promise<MeterRateView[]> {
    return (await ratesOf(db, [row])).get(row.id) ?? [];
  }

  /** A rate for a meter the catalog does not have is refused before anything is written (the FK would say it as a 500). */
  private async metersKnown(tx: Prisma.TransactionClient, edits: MeterRateEdit[]): Promise<void> {
    const unknown = await unknownMeters(tx, edits);
    if (unknown.length > 0) throw new TenantPackageRefused('meter_not_found', unknown.join(', '));
  }

  private async nameFree(name: string): Promise<void> {
    const taken = await this.prisma.tenantFeaturePackage.findUnique({ where: { name }, select: { id: true } });
    if (taken) throw new TenantPackageRefused('package_name_taken', name);
  }

  /** A race past {@link nameFree} meets the unique index and gets the same refusal. */
  private async writing<T>(name: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw new TenantPackageRefused('package_name_taken', name);
      throw e;
    }
  }

  /** The platform owner's tenant — the same check as reseller administration. */
  private async access(actor: TenantPackageActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new TenantPackageRefused('not_platform_owner', 'package administration');
    }
  }

  private audit(
    actor: TenantPackageActor,
    action: AdminAction,
    id: string,
    oldValue: object | null,
    newValue: object,
  ): Prisma.AdminAuditLogUncheckedCreateInput {
    return {
      tenantId: actor.tenantId,
      adminId: actor.adminId,
      action,
      targetEntityType: AuditTargetType.tenant_feature_package,
      targetEntityId: id,
      oldValue: oldValue ? (oldValue as Prisma.InputJsonValue) : Prisma.JsonNull,
      newValue: newValue as Prisma.InputJsonValue,
      adminIpAddress: actor.ip,
    };
  }
}

function toView(row: PackageRow, meterRates: MeterRateView[]): PackageView {
  return {
    id: row.id,
    name: row.name,
    monthlyPrice: row.monthlyPrice?.toString() ?? null,
    yearlyPrice: row.yearlyPrice?.toString() ?? null,
    currencyCode: row.currencyCode,
    includedFeatureKeys: row.includedFeatureKeys as string[],
    isActive: row.isActive,
    meterRates,
  };
}

function pick(view: PackageView, keys: (keyof PackageView)[]): Partial<PackageView> {
  return Object.fromEntries(keys.map((k) => [k, view[k]]));
}
