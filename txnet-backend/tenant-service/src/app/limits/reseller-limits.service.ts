import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, TenantType } from '@prisma/client';
import {
  isResellerLimitKey,
  RESELLER_LIMIT_KEYS,
  RESELLER_LIMITS,
  ResellerAccess,
  type ResellerActor,
  type ResellerLimitKey,
  resellerLimitsOf,
  type ResellerLimitInEffect,
  resellerUsagesOf,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

export type ResellerLimitsActor = { adminId: string; tenantId: string; ip: string };

export type ResellerLimitsRejection = 'not_platform_owner' | 'unknown_limit' | 'limit_out_of_range' | 'package_not_found' | 'reseller_not_found';

export class ResellerLimitsRefused extends Error {
  constructor(
    readonly reason: ResellerLimitsRejection,
    detail = '',
  ) {
    super(`reseller limits refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ResellerLimitsRefused';
  }
}

/** One key, every level that sets it. `platform` null = no row (the code default applies); a `value` null = no limit. */
export type LimitRow = {
  key: ResellerLimitKey;
  codeDefault: number | null;
  max: number;
  platform: { value: number | null } | null;
  packages: Array<{ packageId: string; name: string; value: number | null }>;
  resellers: Array<{ tenantId: string; slug: string; value: number | null; reason: string }>;
};

/** One key in effect for one reseller: `used` is the count its refusal compares, `null` for a key that counts nothing. */
export type LimitInEffectRow = ResellerLimitInEffect & { key: ResellerLimitKey; used: number | null };

/** What an audit row says a level held: a value, `null` (no limit), or `'unset'` (no row). */
type Held = number | null | 'unset';

/**
 * The platform owner's reseller limits (F-019-m, ADR-0106): the platform's
 * value per key, a package's, and one or several resellers' own — set,
 * cleared, read as one table. Every write is audited in its transaction,
 * against the platform's tenant, the package or the reseller.
 *
 * **The platform owner only**, as package administration: the caller's tenant
 * is checked before anything is read. Writes go through the cross-tenant pool,
 * because a reseller's own row is that reseller's (RLS).
 */
@Injectable()
export class ResellerLimitsService {
  private readonly logger = new Logger(ResellerLimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly door: ResellerAccess,
  ) {}

  async table(actor: ResellerLimitsActor): Promise<LimitRow[]> {
    await this.access(actor);
    const [platform, packages, resellers] = await Promise.all([
      this.all.resellerLimitSetting.findMany({ select: { key: true, value: true } }),
      this.all.packageLimit.findMany({ select: { packageId: true, key: true, value: true, package: { select: { name: true } } }, orderBy: { packageId: 'asc' } }),
      Promise.all(
        RESELLER_LIMIT_KEYS.map((key) =>
          this.all.resellerLimit.findMany({
            where: { key },
            select: { tenantId: true, key: true, value: true, reason: true, tenant: { select: { slug: true } } },
            orderBy: { tenantId: 'asc' },
          }),
        ),
      ).then((rows) => rows.flat()),
    ]);
    return RESELLER_LIMIT_KEYS.map((key) => {
      const p = platform.find((r) => r.key === key);
      return {
        key,
        codeDefault: RESELLER_LIMITS[key].default,
        max: RESELLER_LIMITS[key].max,
        platform: p ? { value: p.value } : null,
        packages: packages.filter((r) => r.key === key).map((r) => ({ packageId: r.packageId, name: r.package.name, value: r.value })),
        resellers: resellers.filter((r) => r.key === key).map((r) => ({ tenantId: r.tenantId, slug: r.tenant.slug, value: r.value, reason: r.reason })),
      };
    });
  }

  /**
   * One reseller's limits in effect, where each comes from and how much of it
   * is used (F-019-r, F-019-s) — `resellerLimitsOf` and `resellerUsagesOf`, so
   * the page never resolves a level or counts on its own. `ResellerAccess` is
   * the door, a `read`: the reseller's owner and team, and the platform's staff.
   * Read on the cross-tenant pool: the reseller's own rows are its (RLS).
   */
  async ofReseller(actor: ResellerActor, tenantId: string): Promise<LimitInEffectRow[]> {
    const reseller = await this.door.admit(actor, tenantId, 'read');
    const [limits, used] = await Promise.all([resellerLimitsOf(this.all, reseller.id), resellerUsagesOf(this.all, reseller.id)]);
    return limits.map((row) => ({ ...row, used: used[row.key] }));
  }

  async setPlatform(actor: ResellerLimitsActor, key: string, value: number | null): Promise<void> {
    const k = await this.writable(actor, key, value);
    await this.all.$transaction(async (tx) => {
      const before = await tx.resellerLimitSetting.findUnique({ where: { key: k }, select: { value: true } });
      await tx.resellerLimitSetting.upsert({
        where: { key: k },
        create: { key: k, value, updatedByUserId: actor.adminId },
        update: { value, updatedByUserId: actor.adminId },
      });
      await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.reseller_limit_set, 'platform', k, before ? before.value : 'unset', value) });
    });
  }

  async clearPlatform(actor: ResellerLimitsActor, key: string): Promise<void> {
    const k = await this.known(actor, key);
    await this.all.$transaction(async (tx) => {
      const before = await tx.resellerLimitSetting.findUnique({ where: { key: k }, select: { value: true } });
      if (!before) return;
      await tx.resellerLimitSetting.deleteMany({ where: { key: k } });
      await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.reseller_limit_clear, 'platform', k, before.value, 'unset') });
    });
  }

  async setPackage(actor: ResellerLimitsActor, packageId: string, key: string, value: number | null): Promise<void> {
    const k = await this.writable(actor, key, value);
    await this.all.$transaction(async (tx) => {
      if (!(await tx.tenantFeaturePackage.findUnique({ where: { id: packageId }, select: { id: true } }))) throw new ResellerLimitsRefused('package_not_found', packageId);
      const where = { packageId_key: { packageId, key: k } };
      const before = await tx.packageLimit.findUnique({ where, select: { value: true } });
      await tx.packageLimit.upsert({ where, create: { packageId, key: k, value, updatedByUserId: actor.adminId }, update: { value, updatedByUserId: actor.adminId } });
      await tx.adminAuditLog.create({
        data: this.audit(actor, AdminAction.reseller_limit_set, 'package', k, before ? before.value : 'unset', value, { type: AuditTargetType.tenant_feature_package, id: packageId }),
      });
    });
  }

  async clearPackage(actor: ResellerLimitsActor, packageId: string, key: string): Promise<void> {
    const k = await this.known(actor, key);
    await this.all.$transaction(async (tx) => {
      const before = await tx.packageLimit.findUnique({ where: { packageId_key: { packageId, key: k } }, select: { value: true } });
      if (!before) return;
      await tx.packageLimit.deleteMany({ where: { packageId, key: k } });
      await tx.adminAuditLog.create({
        data: this.audit(actor, AdminAction.reseller_limit_clear, 'package', k, before.value, 'unset', { type: AuditTargetType.tenant_feature_package, id: packageId }),
      });
    });
  }

  /** One or several resellers, all or none: every id is checked to be a live reseller before the first row is written. */
  async setResellers(actor: ResellerLimitsActor, key: string, tenantIds: string[], value: number | null, reason: string) {
    const k = await this.writable(actor, key, value);
    await this.all.$transaction(async (tx) => {
      await this.resellersExist(tx, tenantIds);
      const before = new Map(
        (await tx.resellerLimit.findMany({ where: { key: k, tenantId: { in: tenantIds } }, select: { tenantId: true, value: true } })).map((r) => [r.tenantId, r.value]),
      );
      for (const tenantId of tenantIds) {
        await tx.resellerLimit.upsert({
          where: { tenantId_key: { tenantId, key: k } },
          create: { tenantId, key: k, value, reason, setByUserId: actor.adminId },
          update: { value, reason, setByUserId: actor.adminId },
        });
        const held: Held = before.has(tenantId) ? (before.get(tenantId) ?? null) : 'unset';
        await tx.adminAuditLog.create({
          data: this.audit(actor, AdminAction.reseller_limit_set, 'reseller', k, held, value, { type: AuditTargetType.tenant, id: tenantId }, reason),
        });
      }
    });
    this.logger.log(`limit ${k} = ${value ?? 'none'} for ${tenantIds.length} reseller(s) by ${actor.adminId}`);
    return { key: k, value, tenantIds };
  }

  /** Back to each reseller's package or the platform; a reseller with no row of its own is not an error. */
  async clearResellers(actor: ResellerLimitsActor, key: string, tenantIds: string[]) {
    const k = await this.known(actor, key);
    const cleared = await this.all.$transaction(async (tx) => {
      const rows = await tx.resellerLimit.findMany({ where: { key: k, tenantId: { in: tenantIds } }, select: { tenantId: true, value: true } });
      if (rows.length === 0) return 0;
      await tx.resellerLimit.deleteMany({ where: { key: k, tenantId: { in: rows.map((r) => r.tenantId) } } });
      for (const r of rows) {
        await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.reseller_limit_clear, 'reseller', k, r.value, 'unset', { type: AuditTargetType.tenant, id: r.tenantId }) });
      }
      return rows.length;
    });
    return { key: k, cleared };
  }

  private async resellersExist(tx: Prisma.TransactionClient, tenantIds: string[]): Promise<void> {
    const found = new Set(
      (await tx.tenant.findMany({ where: { id: { in: tenantIds }, tenantType: TenantType.reseller, deletedAt: null }, select: { id: true } })).map((t) => t.id),
    );
    const missing = tenantIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new ResellerLimitsRefused('reseller_not_found', missing.join(','));
  }

  /** The caller may write limits, the key exists, and the value is within its bound. */
  private async writable(actor: ResellerLimitsActor, key: string, value: number | null): Promise<ResellerLimitKey> {
    const k = await this.known(actor, key);
    if (value !== null && value > RESELLER_LIMITS[k].max) throw new ResellerLimitsRefused('limit_out_of_range', `${k} ≤ ${RESELLER_LIMITS[k].max}`);
    return k;
  }

  private async known(actor: ResellerLimitsActor, key: string): Promise<ResellerLimitKey> {
    await this.access(actor);
    if (!isResellerLimitKey(key)) throw new ResellerLimitsRefused('unknown_limit', key);
    return key;
  }

  /** The platform owner's tenant — the same check as package and reseller administration. */
  private async access(actor: ResellerLimitsActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) throw new ResellerLimitsRefused('not_platform_owner', 'reseller limits');
  }

  private audit(
    actor: ResellerLimitsActor,
    action: AdminAction,
    level: 'platform' | 'package' | 'reseller',
    key: ResellerLimitKey,
    before: Held,
    after: Held,
    target: { type: AuditTargetType; id: string } = { type: AuditTargetType.tenant, id: actor.tenantId },
    reason: string | null = null,
  ): Prisma.AdminAuditLogUncheckedCreateInput {
    return {
      tenantId: actor.tenantId,
      adminId: actor.adminId,
      action,
      targetEntityType: target.type,
      targetEntityId: target.id,
      oldValue: { level, key, value: before },
      newValue: { level, key, value: after },
      adminIpAddress: actor.ip,
      reason,
    };
  }
}
