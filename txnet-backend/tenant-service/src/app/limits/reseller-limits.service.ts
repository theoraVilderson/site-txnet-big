import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, QuotaOverageMode, TenantType } from '@prisma/client';
import {
  isResellerLimitKey,
  isResellerQuotaKey,
  lockQuotaTerms,
  overageTermsOf,
  type QuotaLockScope,
  quotaTermsInEffectOf,
  platformCurrencyOf,
  type QuotaOverageTerms,
  RESELLER_QUOTA_KEYS,
  type ResellerLimitKind,
  ResellerQuota,
  type QuotaSpend,
  type QuotaStatement,
  type ResellerQuotaKey,
  RESELLER_LIMIT_KEYS,
  RESELLER_LIMITS,
  ResellerAccess,
  type ResellerActor,
  type ResellerLimitKey,
  resellerLimitsOf,
  type ResellerLimitInEffect,
  resellerUsagesOf,
} from '@txnet-backend/shared-core';

import type { SetOverageInput as OverageInput } from './reseller-limits.schema';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

export type ResellerLimitsActor = { adminId: string; tenantId: string; ip: string };

export type ResellerLimitsRejection = 'not_platform_owner' | 'unknown_limit' | 'limit_out_of_range' | 'package_not_found' | 'reseller_not_found' | 'not_a_quota';

export class ResellerLimitsRefused extends Error {
  constructor(
    readonly reason: ResellerLimitsRejection,
    detail = '',
  ) {
    super(`reseller limits refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ResellerLimitsRefused';
  }
}

/** Past a quota key, as JSON: the price a decimal string with its currency, `null` for `stop`. */
export type OverageView = { mode: QuotaOverageMode; unitPrice: string | null; currencyCode: string | null };

/** One key, every level that sets it. `platform` null = no row (the code default applies); a `value` null = no limit. */
export type LimitRow = {
  key: ResellerLimitKey;
  kind: ResellerLimitKind;
  codeDefault: number | null;
  max: number;
  platform: { value: number | null } | null;
  packages: Array<{ packageId: string; name: string; value: number | null }>;
  resellers: Array<{ tenantId: string; slug: string; value: number | null; reason: string }>;
  /** A quota's answer past its number at each level (ADR-0107); `null` for a guard, which always stops. `platform` null = no row (`stop`). */
  overage: {
    platform: OverageView | null;
    packages: Array<OverageView & { packageId: string; name: string }>;
    resellers: Array<OverageView & { tenantId: string; slug: string; reason: string }>;
  } | null;
};

/**
 * One key in effect for one reseller: `used` is the count its refusal compares,
 * `null` for a key that counts nothing; `overage` what happens past it and where
 * that comes from, `null` for a guard.
 */
export type LimitInEffectRow = ResellerLimitInEffect & {
  key: ResellerLimitKey;
  kind: ResellerLimitKind;
  used: number | null;
  overage: (OverageView & { source: ResellerLimitInEffect['source'] }) | null;
  /** A quota's period, what is included and used in it, and what was sold past it (F-019-v2); `null` for a guard. */
  statement: Pick<QuotaStatement, 'period' | 'includedUsed' | 'overageQty' | 'overageAmount'> | null;
  /** A quota whose terms the platform changed this period: the end of the period they hold until (F-019-v3); else null. */
  lockedUntil: Date | null;
};

/** The reseller's own cap on overage per subscription month and what it has spent (F-019-v2, ADR-0107 point 6). */
export type OverageCapView = QuotaSpend;

/** What an audit row says a level held: a value, `null` (no limit), or `'unset'` (no row). */
type Held = number | null | 'unset';


/** What an overage audit row says a level held. */
type HeldOverage = OverageView | 'unset';

const OVERAGE_SELECT = { mode: true, unitPrice: true, currencyCode: true } as const;

export function overageView(terms: QuotaOverageTerms): OverageView {
  return { mode: terms.mode, unitPrice: terms.unitPrice?.toFixed(2) ?? null, currencyCode: terms.currencyCode };
}

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
    const [platform, packages, resellers, overage] = await Promise.all([
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
      this.overageTable(),
    ]);
    return RESELLER_LIMIT_KEYS.map((key) => {
      const p = platform.find((r) => r.key === key);
      return {
        key,
        kind: RESELLER_LIMITS[key].kind,
        codeDefault: RESELLER_LIMITS[key].default,
        max: RESELLER_LIMITS[key].max,
        platform: p ? { value: p.value } : null,
        packages: packages.filter((r) => r.key === key).map((r) => ({ packageId: r.packageId, name: r.package.name, value: r.value })),
        resellers: resellers.filter((r) => r.key === key).map((r) => ({ tenantId: r.tenantId, slug: r.tenant.slug, value: r.value, reason: r.reason })),
        overage: isResellerQuotaKey(key) ? overage(key) : null,
      };
    });
  }

  /** Every level's overage row of every quota key, as one lookup per key. */
  private async overageTable() {
    const keys = { key: { in: [...RESELLER_QUOTA_KEYS] as string[] } };
    const [platform, packages, resellers] = await Promise.all([
      this.all.quotaOverageSetting.findMany({ where: keys, select: { key: true, ...OVERAGE_SELECT } }),
      this.all.packageQuotaOverage.findMany({ where: keys, select: { key: true, packageId: true, ...OVERAGE_SELECT, package: { select: { name: true } } }, orderBy: { packageId: 'asc' } }),
      this.all.resellerQuotaOverage.findMany({
        where: keys,
        select: { key: true, tenantId: true, reason: true, ...OVERAGE_SELECT, tenant: { select: { slug: true } } },
        orderBy: { tenantId: 'asc' },
      }),
    ]);
    return (key: ResellerQuotaKey): NonNullable<LimitRow['overage']> => {
      const p = platform.find((r) => r.key === key);
      return {
        platform: p ? overageView(overageTermsOf(p)) : null,
        packages: packages.filter((r) => r.key === key).map((r) => ({ packageId: r.packageId, name: r.package.name, ...overageView(overageTermsOf(r)) })),
        resellers: resellers.filter((r) => r.key === key).map((r) => ({ tenantId: r.tenantId, slug: r.tenant.slug, reason: r.reason, ...overageView(overageTermsOf(r)) })),
      };
    };
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
    const [limits, used, statements, terms] = await Promise.all([
      resellerLimitsOf(this.all, reseller.id),
      resellerUsagesOf(this.all, reseller.id),
      Promise.all(RESELLER_QUOTA_KEYS.map((key) => ResellerQuota.statementOf(this.all, reseller.id, key))),
      Promise.all(RESELLER_QUOTA_KEYS.map((key) => quotaTermsInEffectOf(this.all, reseller.id, key))),
    ]);
    return limits.map((row) => {
      const key = row.key;
      const at = isResellerQuotaKey(key) ? RESELLER_QUOTA_KEYS.indexOf(key) : -1;
      const st = at >= 0 ? statements[at] : null;
      // A quota shows the terms the engine applies: the period's locked ones where kinder (F-019-v3).
      const t = at >= 0 ? terms[at] : null;
      return {
        ...row,
        ...(t ? { limit: t.included, source: t.includedSource } : {}),
        kind: RESELLER_LIMITS[row.key].kind,
        // A quota's count is the engine's: every unit consumed this period, included or sold past it (F-019-v4).
        used: st ? st.includedUsed + st.overageQty : used[row.key],
        overage: t ? { ...overageView(t.overage), source: t.overageSource } : null,
        statement: st ? { period: st.period, includedUsed: st.includedUsed, overageQty: st.overageQty, overageAmount: st.overageAmount } : null,
        lockedUntil: t?.lockedUntil ?? null,
      };
    });
  }

  /** The reseller's overage cap and this month's spend. A `read`: its owner and team, and the platform's staff. */
  async overageCapOf(actor: ResellerActor, tenantId: string): Promise<OverageCapView> {
    const reseller = await this.door.admit(actor, tenantId, 'read');
    return ResellerQuota.spendOf(this.all, reseller.id);
  }

  /**
   * Sets (or, with `null`, removes) the reseller's own cap, in the platform's
   * currency — the wallet's. A money decision of the reseller's, so the door is
   * `tenantBilling` (who may top up may bound what overage spends); audited
   * in the reseller's own log. Lowering it below this month's spend refuses
   * the next overage unit, never takes back one already sold.
   */
  async setOverageCap(actor: ResellerActor & { ip: string }, tenantId: string, amount: string | null): Promise<OverageCapView> {
    const reseller = await this.door.admit(actor, tenantId, 'tenantBilling');
    await this.all.$transaction(async (tx) => {
      const before = await tx.resellerOverageCap.findUnique({ where: { tenantId: reseller.id }, select: { amount: true, currencyCode: true } });
      if (amount === null) {
        if (!before) return;
        await tx.resellerOverageCap.delete({ where: { tenantId: reseller.id } });
      } else {
        const data = { amount: new Prisma.Decimal(amount), currencyCode: await platformCurrencyOf(tx), setByUserId: actor.userId };
        await tx.resellerOverageCap.upsert({ where: { tenantId: reseller.id }, create: { tenantId: reseller.id, ...data }, update: data });
      }
      const view = (row: { amount: Prisma.Decimal; currencyCode: string } | null) => (row ? { amount: row.amount.toFixed(2), currencyCode: row.currencyCode } : null);
      await tx.adminAuditLog.create({
        data: {
          tenantId: reseller.id,
          adminId: actor.userId,
          action: AdminAction.reseller_overage_cap_set,
          targetEntityType: AuditTargetType.tenant,
          targetEntityId: reseller.id,
          oldValue: { cap: view(before) },
          newValue: { cap: amount === null ? null : { amount: new Prisma.Decimal(amount).toFixed(2), currencyCode: await platformCurrencyOf(tx) } },
          adminIpAddress: actor.ip,
        },
      });
    });
    return ResellerQuota.spendOf(this.all, reseller.id);
  }

  async setPlatform(actor: ResellerLimitsActor, key: string, value: number | null): Promise<void> {
    const k = await this.writable(actor, key, value);
    await this.all.$transaction(async (tx) => {
      const before = await tx.resellerLimitSetting.findUnique({ where: { key: k }, select: { value: true } });
      await freeze(tx, k, { everyReseller: true });
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
      await freeze(tx, k, { everyReseller: true });
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
      await freeze(tx, k, { packageId });
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
      await freeze(tx, k, { packageId });
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
      await freeze(tx, k, { tenantIds });
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
      await freeze(tx, k, { tenantIds: rows.map((r) => r.tenantId) });
      await tx.resellerLimit.deleteMany({ where: { key: k, tenantId: { in: rows.map((r) => r.tenantId) } } });
      for (const r of rows) {
        await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.reseller_limit_clear, 'reseller', k, r.value, 'unset', { type: AuditTargetType.tenant, id: r.tenantId }) });
      }
      return rows.length;
    });
    return { key: k, cleared };
  }

  /** The platform's answer past a quota key (ADR-0107 point 2), over the code default `stop`. */
  async setPlatformOverage(actor: ResellerLimitsActor, key: string, input: OverageInput): Promise<void> {
    const k = await this.quota(actor, key);
    await this.all.$transaction(async (tx) => {
      const data = await this.overageData(tx, input, actor.adminId);
      const before = await tx.quotaOverageSetting.findUnique({ where: { key: k }, select: OVERAGE_SELECT });
      await freeze(tx, k, { everyReseller: true });
      await tx.quotaOverageSetting.upsert({ where: { key: k }, create: { key: k, ...data }, update: data });
      await tx.adminAuditLog.create({ data: this.overageAudit(actor, AdminAction.reseller_overage_set, 'platform', k, held(before), viewOf(data)) });
    });
  }

  async clearPlatformOverage(actor: ResellerLimitsActor, key: string): Promise<void> {
    const k = await this.quota(actor, key);
    await this.all.$transaction(async (tx) => {
      const before = await tx.quotaOverageSetting.findUnique({ where: { key: k }, select: OVERAGE_SELECT });
      if (!before) return;
      await freeze(tx, k, { everyReseller: true });
      await tx.quotaOverageSetting.deleteMany({ where: { key: k } });
      await tx.adminAuditLog.create({ data: this.overageAudit(actor, AdminAction.reseller_overage_clear, 'platform', k, held(before), 'unset') });
    });
  }

  async setPackageOverage(actor: ResellerLimitsActor, packageId: string, key: string, input: OverageInput): Promise<void> {
    const k = await this.quota(actor, key);
    await this.all.$transaction(async (tx) => {
      if (!(await tx.tenantFeaturePackage.findUnique({ where: { id: packageId }, select: { id: true } }))) throw new ResellerLimitsRefused('package_not_found', packageId);
      const data = await this.overageData(tx, input, actor.adminId);
      const where = { packageId_key: { packageId, key: k } };
      const before = await tx.packageQuotaOverage.findUnique({ where, select: OVERAGE_SELECT });
      await freeze(tx, k, { packageId });
      await tx.packageQuotaOverage.upsert({ where, create: { packageId, key: k, ...data }, update: data });
      await tx.adminAuditLog.create({
        data: this.overageAudit(actor, AdminAction.reseller_overage_set, 'package', k, held(before), viewOf(data), { type: AuditTargetType.tenant_feature_package, id: packageId }),
      });
    });
  }

  async clearPackageOverage(actor: ResellerLimitsActor, packageId: string, key: string): Promise<void> {
    const k = await this.quota(actor, key);
    await this.all.$transaction(async (tx) => {
      const before = await tx.packageQuotaOverage.findUnique({ where: { packageId_key: { packageId, key: k } }, select: OVERAGE_SELECT });
      if (!before) return;
      await freeze(tx, k, { packageId });
      await tx.packageQuotaOverage.deleteMany({ where: { packageId, key: k } });
      await tx.adminAuditLog.create({
        data: this.overageAudit(actor, AdminAction.reseller_overage_clear, 'package', k, held(before), 'unset', { type: AuditTargetType.tenant_feature_package, id: packageId }),
      });
    });
  }

  /** One or several resellers, all or none, as `setResellers`. */
  async setResellersOverage(actor: ResellerLimitsActor, key: string, tenantIds: string[], input: OverageInput, reason: string) {
    const k = await this.quota(actor, key);
    const view = await this.all.$transaction(async (tx) => {
      await this.resellersExist(tx, tenantIds);
      const { updatedByUserId, ...terms } = await this.overageData(tx, input, actor.adminId);
      const before = new Map(
        (await tx.resellerQuotaOverage.findMany({ where: { key: k, tenantId: { in: tenantIds } }, select: { tenantId: true, ...OVERAGE_SELECT } })).map((r) => [r.tenantId, r]),
      );
      await freeze(tx, k, { tenantIds });
      for (const tenantId of tenantIds) {
        const data = { ...terms, reason, setByUserId: updatedByUserId };
        await tx.resellerQuotaOverage.upsert({ where: { tenantId_key: { tenantId, key: k } }, create: { tenantId, key: k, ...data }, update: data });
        await tx.adminAuditLog.create({
          data: this.overageAudit(actor, AdminAction.reseller_overage_set, 'reseller', k, held(before.get(tenantId) ?? null), viewOf(terms), { type: AuditTargetType.tenant, id: tenantId }, reason),
        });
      }
      return viewOf(terms);
    });
    this.logger.log(`overage ${k} = ${view.mode}${view.unitPrice ? ` ${view.unitPrice} ${view.currencyCode}` : ''} for ${tenantIds.length} reseller(s) by ${actor.adminId}`);
    return { key: k, ...view, tenantIds };
  }

  async clearResellersOverage(actor: ResellerLimitsActor, key: string, tenantIds: string[]) {
    const k = await this.quota(actor, key);
    const cleared = await this.all.$transaction(async (tx) => {
      const rows = await tx.resellerQuotaOverage.findMany({ where: { key: k, tenantId: { in: tenantIds } }, select: { tenantId: true, ...OVERAGE_SELECT } });
      if (rows.length === 0) return 0;
      await freeze(tx, k, { tenantIds: rows.map((r) => r.tenantId) });
      await tx.resellerQuotaOverage.deleteMany({ where: { key: k, tenantId: { in: rows.map((r) => r.tenantId) } } });
      for (const r of rows) {
        await tx.adminAuditLog.create({ data: this.overageAudit(actor, AdminAction.reseller_overage_clear, 'reseller', k, held(r), 'unset', { type: AuditTargetType.tenant, id: r.tenantId }) });
      }
      return rows.length;
    });
    return { key: k, cleared };
  }

  /** The row's terms: an overage price is stamped with the platform's currency now, which every reseller's billing wallet is kept in. */
  private async overageData(tx: Prisma.TransactionClient, input: OverageInput, adminId: string) {
    if (input.mode === 'stop') return { mode: QuotaOverageMode.stop, unitPrice: null, currencyCode: null, updatedByUserId: adminId };
    return { mode: QuotaOverageMode.overage, unitPrice: new Prisma.Decimal(input.unitPrice), currencyCode: await platformCurrencyOf(tx), updatedByUserId: adminId };
  }

  /** A known key whose registry kind is `quota`; a guard is never sold past (ADR-0107 point 1). */
  private async quota(actor: ResellerLimitsActor, key: string): Promise<ResellerQuotaKey> {
    const k = await this.known(actor, key);
    if (!isResellerQuotaKey(k)) throw new ResellerLimitsRefused('not_a_quota', k);
    return k;
  }

  private overageAudit(
    actor: ResellerLimitsActor,
    action: AdminAction,
    level: 'platform' | 'package' | 'reseller',
    key: ResellerQuotaKey,
    before: HeldOverage,
    after: HeldOverage,
    target: { type: AuditTargetType; id: string } = { type: AuditTargetType.tenant, id: actor.tenantId },
    reason: string | null = null,
  ): Prisma.AdminAuditLogUncheckedCreateInput {
    return {
      tenantId: actor.tenantId,
      adminId: actor.adminId,
      action,
      targetEntityType: target.type,
      targetEntityId: target.id,
      oldValue: { level, key, overage: before },
      newValue: { level, key, overage: after },
      adminIpAddress: actor.ip,
      reason,
    };
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

/**
 * Before a quota key's terms change at any level, the resellers it reaches keep
 * theirs for the period they paid for (ADR-0107 point 8, F-019-v3). A guard is
 * never locked: it is protection, not something sold.
 */
async function freeze(tx: Prisma.TransactionClient, key: ResellerLimitKey, scope: QuotaLockScope): Promise<void> {
  if (isResellerQuotaKey(key)) await lockQuotaTerms(tx, scope, [key]);
}

function viewOf(row: { mode: QuotaOverageMode; unitPrice: Prisma.Decimal | null; currencyCode: string | null }): OverageView {
  return overageView(overageTermsOf(row));
}

function held(row: { mode: QuotaOverageMode; unitPrice: Prisma.Decimal | null; currencyCode: string | null } | null): HeldOverage {
  return row ? viewOf(row) : 'unset';
}
