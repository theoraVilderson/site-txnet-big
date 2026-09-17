import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, TenantType } from '@prisma/client';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { addPackageEntitlements, lockPackage, lockSubscribers, replacePackageEntitlements } from '../subscription/package-entitlements';
import type { CreatePackageInput, ListPackagesInput, UpdatePackageInput } from './tenant-package.schema';

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
 */

export type TenantPackageActor = { adminId: string; tenantId: string; ip: string };

export type PackageApplyView = { packageId: string; includedFeatureKeys: string[]; subscribers: number };

export type PackageView = {
  id: string;
  name: string;
  monthlyPrice: string | null;
  yearlyPrice: string | null;
  includedFeatureKeys: string[];
  isActive: boolean;
};

export type TenantPackageRejection = 'not_platform_owner' | 'package_not_found' | 'package_name_taken' | 'package_unpriced';

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
        const row = await tx.tenantFeaturePackage.create({
          data: {
            name: input.name,
            monthlyPrice: input.monthlyPrice ?? null,
            yearlyPrice: input.yearlyPrice ?? null,
            includedFeatureKeys: input.includedFeatureKeys,
          },
          select: PACKAGE_SELECT,
        });
        const created = toView(row);
        await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.tenant_package_create, created.id, null, created) });
        return created;
      }),
    );
    this.logger.log(`package ${view.id} (${view.name}) created by ${actor.adminId}`);
    return view;
  }

  async update(actor: TenantPackageActor, id: string, patch: UpdatePackageInput): Promise<PackageView> {
    await this.access(actor);
    const before = toView(await this.find(id));
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
        const held = patch.includedFeatureKeys === undefined ? null : await tx.tenantFeaturePackage.findUnique({ where: { id }, select: { includedFeatureKeys: true } });
        const after = toView(await tx.tenantFeaturePackage.update({ where: { id }, data, select: PACKAGE_SELECT }));
        if (held) {
          const had = new Set(held.includedFeatureKeys as string[]);
          const added = after.includedFeatureKeys.filter((k) => !had.has(k));
          if (added.length > 0) await addPackageEntitlements(tx, await lockSubscribers(tx, id), added);
        }
        const changed = Object.keys(data) as (keyof PackageView)[];
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
    return rows.map(toView);
  }

  async read(actor: TenantPackageActor, id: string): Promise<PackageView> {
    await this.access(actor);
    return toView(await this.find(id));
  }

  private async find(id: string): Promise<PackageRow> {
    const row = await this.prisma.tenantFeaturePackage.findUnique({ where: { id }, select: PACKAGE_SELECT });
    if (!row) throw new TenantPackageRefused('package_not_found', id);
    return row;
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

function toView(row: PackageRow): PackageView {
  return {
    id: row.id,
    name: row.name,
    monthlyPrice: row.monthlyPrice?.toString() ?? null,
    yearlyPrice: row.yearlyPrice?.toString() ?? null,
    includedFeatureKeys: row.includedFeatureKeys as string[],
    isActive: row.isActive,
  };
}

function pick(view: PackageView, keys: (keyof PackageView)[]): Partial<PackageView> {
  return Object.fromEntries(keys.map((k) => [k, view[k]]));
}
