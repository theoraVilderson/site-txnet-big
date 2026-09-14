import { Injectable, Logger } from '@nestjs/common';
import { CouponChannel, CouponVisibility, DiscountType, Prisma, TenantType } from '@prisma/client';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { GatewaySource } from '../gateway/gateway-merchant';

/** Who is acting, as the gate proved it. Never taken from a body. */
export type CouponActor = { adminId: string; tenantId: string; ip: string };

export type CouponGatewayRef = { source: GatewaySource; id: string };
export type CouponScopeRef = { servicePlanId?: string | null; categoryId?: string | null };

/** Every editable field, as it travels: decimals as strings (C-02), instants as ISO strings or `Date`s. */
export type CouponFields = {
  code?: string;
  discountType?: string;
  discountValue?: string;
  maxDiscountCap?: string | null;
  minPurchaseAmount?: string | null;
  maxPurchaseAmount?: string | null;
  totalUsageLimit?: number | null;
  perUserUsageLimit?: number;
  expiresAt?: string | Date | null;
  validFrom?: string | Date | null;
  isActive?: boolean;
  visibility?: string;
  activeWeekdays?: number[];
  activeHourFrom?: number | null;
  activeHourTo?: number | null;
  firstPurchaseOnly?: boolean;
  newUserWithinDays?: number | null;
  periodUsageLimit?: number | null;
  periodDays?: number | null;
  allowedChannels?: string[];
  label?: string | null;
  note?: string | null;
  /** `coupon_allowed_user`; matters when `visibility` is `targeted`. Given = the whole set. */
  allowedUserIds?: string[];
  /** `coupon_tenant`, platform coupons only (ADR-0048 decision 2). Given = the whole set. */
  tenantIds?: string[];
  /** `coupon_gateway`; none = any gateway. Given = the whole set. */
  gateways?: CouponGatewayRef[];
  /** `coupon_service_scope`; none = open scope. Given = the whole set. */
  serviceScopes?: CouponScopeRef[];
};
/** `tenantId`: absent = the caller's tenant; `null` = a platform coupon; another id = the platform owner's alone. */
export type CreateCouponInput = CouponFields & { code: string; discountType: string; discountValue: string; tenantId?: string | null };
export type UpdateCouponInput = CouponFields;

export type CouponStatus = 'active' | 'inactive' | 'scheduled' | 'expired' | 'exhausted' | 'deleted';

export type CouponView = {
  id: string;
  /** `null` = a platform coupon. */
  tenantId: string | null;
  code: string;
  discountType: string;
  discountValue: string;
  maxDiscountCap: string | null;
  minPurchaseAmount: string | null;
  maxPurchaseAmount: string | null;
  totalUsageLimit: number | null;
  perUserUsageLimit: number;
  usedCount: number;
  reservedCount: number;
  expiresAt: Date | null;
  validFrom: Date | null;
  isActive: boolean;
  visibility: string;
  activeWeekdays: number[];
  activeHourFrom: number | null;
  activeHourTo: number | null;
  firstPurchaseOnly: boolean;
  newUserWithinDays: number | null;
  periodUsageLimit: number | null;
  periodDays: number | null;
  allowedChannels: string[];
  label: string | null;
  note: string | null;
  batchId: string | null;
  allowedUserIds: string[];
  tenantIds: string[];
  gateways: CouponGatewayRef[];
  serviceScopes: Array<{ servicePlanId: string | null; categoryId: string | null }>;
  status: CouponStatus;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The list's status filter and kind filter, as tuples the wire schema derives from (C-09). */
export const COUPON_LIST_STATUSES = ['active', 'inactive', 'expired', 'deleted'] as const;
export const COUPON_KINDS = ['discount', 'gift'] as const;

export type CouponListFilter = {
  /** The platform owner only; a tenant's is ignored. `platform` = platform coupons. */
  tenantId?: string;
  status?: (typeof COUPON_LIST_STATUSES)[number];
  /** `discount` = percentage and fixed; `gift` = wallet credit. */
  kind?: (typeof COUPON_KINDS)[number];
  /** Part of the code or the label. */
  q?: string;
  batchId?: string;
  page?: number;
  pageSize?: number;
};

export type CouponAdminRejection =
  | 'not_platform_owner'
  | 'coupon_not_found'
  | 'tenant_not_found'
  | 'code_taken'
  | 'invalid_code'
  | 'invalid_value'
  | 'invalid_limit'
  | 'limits_not_for_gift_codes'
  | 'tenants_are_platform_coupons'
  | 'targeted_needs_users'
  | 'user_out_of_scope'
  | 'platform_coupon_needs_platform_gateway'
  | 'gateway_not_found'
  | 'scope_not_found'
  | 'used_coupon_frozen'
  | 'capacity_below_used'
  | 'batch_not_found'
  | 'invalid_batch';

/** A refusal. Its message names the rule and a row id, never a user's data. */
export class CouponAdminRefused extends Error {
  constructor(readonly reason: CouponAdminRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'CouponAdminRefused';
  }
}

type Row = Record<string, unknown>;
type Tx = Prisma.TransactionClient;

const CODE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const DECIMAL_COLUMNS = ['discountValue', 'maxDiscountCap', 'minPurchaseAmount', 'maxPurchaseAmount'] as const;
const PLAIN_COLUMNS = [
  'code', 'discountType', 'totalUsageLimit', 'perUserUsageLimit', 'isActive', 'visibility', 'activeWeekdays', 'activeHourFrom',
  'activeHourTo', 'firstPurchaseOnly', 'newUserWithinDays', 'periodUsageLimit', 'periodDays', 'allowedChannels', 'label', 'note',
] as const;
const DATE_COLUMNS = ['expiresAt', 'validFrom'] as const;
/**
 * What `redeem_gift_coupon` never reads (contract.coupon.md, F-502-k): a gift
 * code has no amount, gateway, channel or purchase, so a limit on one would be
 * a promise the redeem path does not keep.
 */
const NOT_FOR_GIFT_CODES = [
  'maxDiscountCap', 'minPurchaseAmount', 'maxPurchaseAmount', 'validFrom', 'activeHourFrom', 'activeHourTo', 'newUserWithinDays',
  'periodUsageLimit', 'periodDays',
] as const;
const PAGE_MAX = 100;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const dec = (v: unknown): Prisma.Decimal | null => (v === null || v === undefined || v === '' ? null : new Prisma.Decimal(String(v)));
const date = (v: unknown): Date | null => (v === null || v === undefined || v === '' ? null : v instanceof Date ? v : new Date(String(v)));
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Managing coupons (F-502-c, D-33, ADR-0048): create, change, switch on and off
 * and delete `billing.coupon` rows with their allowed users, served tenants,
 * gateways and service scopes. Gift-code batches are `CouponBatchService`'s
 * (F-502-d) and the usage report `CouponUsageService`'s (F-502-e); both enter
 * through {@link access} and {@link loadManaged}.
 *
 * **Who may touch what.** The platform owner: platform coupons and every
 * tenant's. Any other tenant: its own. A coupon outside a caller's reach, or
 * soft-deleted, is `coupon_not_found`.
 *
 * **Why the cross-tenant pool.** `coupon`'s `WITH CHECK` is strict, so even the
 * platform owner's connection cannot write a platform coupon, and
 * `coupon_tenant` is written on this pool by design (ADR-0048 decision 3). As in
 * `GatewayAdminService`, the boundary is this file: {@link access} is read on
 * the application pool inside the caller's own scope, and every method decides
 * from it before it reads or writes a row.
 *
 * **A used coupon** (a counter above zero, or any redemption row) keeps its type
 * and value — a receipt already says what it took — and its `totalUsageLimit`
 * never drops below `usedCount + reservedCount`. The comparison and the write
 * share a transaction; `reserve_coupon` takes the row lock for its own count.
 */
@Injectable()
export class CouponAdminService {
  private readonly logger = new Logger(CouponAdminService.name);

  constructor(
    /** The caller's own tenant, bound by RLS — used for one read: who is asking. */
    private readonly prisma: PrismaService,
    /** Every tenant's coupon rows, by policy. See the class comment. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /** Whether the caller is the platform owner. The door every coupon surface goes through. */
  async access(actor: CouponActor): Promise<{ owner: boolean }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return { owner: tenant?.tenantType === TenantType.platform_owner };
  }

  /**
   * Whose a new coupon or batch is. Absent = the caller's tenant; `null` = the
   * platform's; another tenant = the platform owner's alone.
   */
  async ownerOfNew(actor: CouponActor, requested: string | null | undefined): Promise<string | null> {
    const tenantId = requested === undefined ? actor.tenantId : requested;
    if (tenantId === actor.tenantId) return tenantId;
    const { owner } = await this.access(actor);
    if (!owner) throw new CouponAdminRefused('not_platform_owner', tenantId === null ? 'a platform coupon' : "another tenant's coupon");
    if (tenantId !== null && !(await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      throw new CouponAdminRefused('tenant_not_found', tenantId);
    }
    return tenantId;
  }

  /** The coupon row, if the caller may manage it. Deleted and out-of-reach rows are not found. */
  async loadManaged(actor: CouponActor, id: string, owner: boolean, opts: { includeDeleted?: boolean } = {}): Promise<Row> {
    const row = (await this.all.coupon.findUnique({ where: { id } })) as unknown as Row | null;
    if (!row || (!opts.includeDeleted && row['deletedAt'] != null)) throw new CouponAdminRefused('coupon_not_found', id);
    if (!owner && row['tenantId'] !== actor.tenantId) throw new CouponAdminRefused('coupon_not_found', id);
    return row;
  }

  async list(actor: CouponActor, filter: CouponListFilter): Promise<{ items: CouponView[]; total: number; page: number; pageSize: number }> {
    const { owner } = await this.access(actor);
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const pageSize = Math.min(PAGE_MAX, Math.max(1, Math.floor(filter.pageSize ?? 20)));
    const where = this.listWhere(actor, owner, filter);
    const [rows, total] = await Promise.all([
      this.all.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.all.coupon.count({ where }),
    ]);
    return { items: await this.views(rows as unknown as Row[]), total, page, pageSize };
  }

  async get(actor: CouponActor, id: string): Promise<CouponView> {
    const { owner } = await this.access(actor);
    const row = await this.loadManaged(actor, id, owner);
    return (await this.views([row]))[0];
  }

  async create(actor: CouponActor, input: CreateCouponInput): Promise<CouponView> {
    const tenantId = await this.ownerOfNew(actor, input.tenantId);

    const next = this.merged(null, input);
    next['tenantId'] = tenantId;
    const relations = await this.checkRelations(actor, tenantId, next, input, { tenantIds: [], allowedUserIds: [], gateways: [], serviceScopes: [] });

    const created = await this.all.$transaction(async (tx) => {
      await this.assertCodeFree(tx, tenantId, next['code'] as string, null);
      const row = (await tx.coupon.create({
        data: { ...this.columns(next), tenantId, createdByAdminId: actor.adminId } as Prisma.CouponUncheckedCreateInput,
      })) as unknown as Row;
      await this.writeRelations(tx, row['id'] as string, relations, input);
      const [view] = await this.views([row], tx);
      await tx.adminAuditLog.create({
        data: {
          tenantId: tenantId ?? actor.tenantId,
          adminId: actor.adminId,
          action: 'coupon_create',
          targetEntityType: 'coupon',
          targetEntityId: view.id,
          oldValue: Prisma.DbNull,
          newValue: this.snapshot(view) as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      return view;
    });
    this.logger.log(`coupon ${created.id} created by ${actor.adminId}`);
    return created;
  }

  async update(actor: CouponActor, id: string, patch: UpdateCouponInput): Promise<CouponView> {
    const { owner } = await this.access(actor);
    const row = await this.loadManaged(actor, id, owner);
    const [before] = await this.views([row]);
    const tenantId = row['tenantId'] as string | null;

    const next = this.merged(row, patch);
    const relations = await this.checkRelations(actor, tenantId, next, patch, before);

    const updated = await this.all.$transaction(async (tx) => {
      const fresh = (await tx.coupon.findUnique({ where: { id } })) as unknown as Row;
      const redemptions = await tx.couponRedemption.count({ where: { couponId: id } });
      const used = Number(fresh['usedCount']) > 0 || Number(fresh['reservedCount']) > 0 || redemptions > 0;
      if (used) {
        if (next['discountType'] !== fresh['discountType']) throw new CouponAdminRefused('used_coupon_frozen', 'discountType');
        if (!dec(next['discountValue'])!.equals(dec(fresh['discountValue'])!)) throw new CouponAdminRefused('used_coupon_frozen', 'discountValue');
      }
      const floor = Number(fresh['usedCount']) + Number(fresh['reservedCount']);
      if (patch.totalUsageLimit !== undefined && patch.totalUsageLimit !== null && patch.totalUsageLimit < floor) {
        throw new CouponAdminRefused('capacity_below_used', `${patch.totalUsageLimit} < ${floor}`);
      }
      if (patch.code !== undefined) await this.assertCodeFree(tx, tenantId, next['code'] as string, id);

      const data = this.columns(next);
      const saved = (await tx.coupon.update({ where: { id }, data: data as Prisma.CouponUncheckedUpdateInput })) as unknown as Row;
      await this.writeRelations(tx, id, relations, patch, true);
      const [after] = await this.views([saved], tx);

      const a = this.snapshot(after);
      const b = this.snapshot(before);
      const changed = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      await tx.adminAuditLog.create({
        data: {
          tenantId: tenantId ?? actor.tenantId,
          adminId: actor.adminId,
          action: 'coupon_update',
          targetEntityType: 'coupon',
          targetEntityId: id,
          oldValue: Object.fromEntries(changed.map((k) => [k, b[k]])) as Prisma.InputJsonValue,
          newValue: Object.fromEntries(changed.map((k) => [k, a[k]])) as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      return after;
    });
    this.logger.log(`coupon ${id} updated by ${actor.adminId}`);
    return updated;
  }

  /**
   * Delete a coupon (ADR-0048 decision 6). Nothing ever redeemed it: the row and
   * its child rows go. Anything did, in any status: it is switched off and
   * marked deleted, so its receipts stay explicable and its code is free again.
   */
  async remove(actor: CouponActor, id: string): Promise<{ id: string; mode: 'deleted' | 'soft_deleted' }> {
    const { owner } = await this.access(actor);
    const row = await this.loadManaged(actor, id, owner);
    const [before] = await this.views([row]);

    const mode = await this.all.$transaction(async (tx) => {
      const redemptions = await tx.couponRedemption.count({ where: { couponId: id } });
      const soft = redemptions > 0;
      if (soft) {
        await tx.coupon.update({ where: { id }, data: { isActive: false, deletedAt: new Date(), deletedByAdminId: actor.adminId } });
      } else {
        await tx.couponTenant.deleteMany({ where: { couponId: id } });
        await tx.couponAllowedUser.deleteMany({ where: { couponId: id } });
        await tx.couponGateway.deleteMany({ where: { couponId: id } });
        await tx.couponServiceScope.deleteMany({ where: { couponId: id } });
        await tx.coupon.delete({ where: { id } });
      }
      await tx.adminAuditLog.create({
        data: {
          tenantId: (row['tenantId'] as string | null) ?? actor.tenantId,
          adminId: actor.adminId,
          action: 'coupon_delete',
          targetEntityType: 'coupon',
          targetEntityId: id,
          oldValue: this.snapshot(before) as Prisma.InputJsonValue,
          newValue: { mode: soft ? 'soft_deleted' : 'deleted', redemptions },
          adminIpAddress: actor.ip,
        },
      });
      return soft ? ('soft_deleted' as const) : ('deleted' as const);
    });
    this.logger.log(`coupon ${id} ${mode} by ${actor.adminId}`);
    return { id, mode };
  }

  /** Views of coupon rows with their child rows, in the order given. */
  async views(rows: Row[], tx?: Tx): Promise<CouponView[]> {
    if (rows.length === 0) return [];
    const db = (tx ?? this.all) as Tx;
    const ids = rows.map((r) => r['id'] as string);
    const where = { couponId: { in: ids } };
    const [users, tenants, gateways, scopes] = await Promise.all([
      db.couponAllowedUser.findMany({ where }),
      db.couponTenant.findMany({ where }),
      db.couponGateway.findMany({ where }),
      db.couponServiceScope.findMany({ where }),
    ]);
    const of = <T extends { couponId: string }>(list: T[], id: string) => list.filter((x) => x.couponId === id);
    const now = Date.now();
    return rows.map((row) => {
      const id = row['id'] as string;
      return {
        id,
        tenantId: (row['tenantId'] as string | null) ?? null,
        code: row['code'] as string,
        discountType: row['discountType'] as string,
        discountValue: String(row['discountValue']),
        maxDiscountCap: str(row['maxDiscountCap']),
        minPurchaseAmount: str(row['minPurchaseAmount']),
        maxPurchaseAmount: str(row['maxPurchaseAmount']),
        totalUsageLimit: (row['totalUsageLimit'] as number | null) ?? null,
        perUserUsageLimit: Number(row['perUserUsageLimit'] ?? 1),
        usedCount: Number(row['usedCount'] ?? 0),
        reservedCount: Number(row['reservedCount'] ?? 0),
        expiresAt: date(row['expiresAt']),
        validFrom: date(row['validFrom']),
        isActive: Boolean(row['isActive']),
        visibility: row['visibility'] as string,
        activeWeekdays: (row['activeWeekdays'] as number[] | undefined) ?? [],
        activeHourFrom: (row['activeHourFrom'] as number | null) ?? null,
        activeHourTo: (row['activeHourTo'] as number | null) ?? null,
        firstPurchaseOnly: Boolean(row['firstPurchaseOnly']),
        newUserWithinDays: (row['newUserWithinDays'] as number | null) ?? null,
        periodUsageLimit: (row['periodUsageLimit'] as number | null) ?? null,
        periodDays: (row['periodDays'] as number | null) ?? null,
        allowedChannels: (row['allowedChannels'] as string[] | undefined) ?? [],
        label: str(row['label']),
        note: str(row['note']),
        batchId: str(row['batchId']),
        allowedUserIds: of(users, id).map((u) => u.userId),
        tenantIds: of(tenants, id).map((t) => t.tenantId),
        gateways: of(gateways, id).map((g) => (g.gatewayId ? { source: 'platform' as const, id: g.gatewayId } : { source: 'tenant' as const, id: g.tenantGatewayConfigId as string })),
        serviceScopes: of(scopes, id).map((s) => ({ servicePlanId: s.servicePlanId ?? null, categoryId: s.categoryId ?? null })),
        status: statusOf(row, now),
        deletedAt: date(row['deletedAt']),
        createdAt: row['createdAt'] as Date,
        updatedAt: row['updatedAt'] as Date,
      };
    });
  }

  private listWhere(actor: CouponActor, owner: boolean, filter: CouponListFilter): Prisma.CouponWhereInput {
    const where: Prisma.CouponWhereInput = {};
    if (!owner) where.tenantId = actor.tenantId;
    else if (filter.tenantId === 'platform') where.tenantId = null;
    else if (filter.tenantId) where.tenantId = filter.tenantId;

    if (filter.status === 'deleted') where.deletedAt = { not: null };
    else where.deletedAt = null;

    const and: Prisma.CouponWhereInput[] = [];
    const now = new Date();
    if (filter.status === 'active') and.push({ isActive: true }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    if (filter.status === 'inactive') and.push({ isActive: false });
    if (filter.status === 'expired') and.push({ expiresAt: { lte: now } });
    if (filter.kind === 'gift') and.push({ discountType: DiscountType.wallet_credit });
    if (filter.kind === 'discount') and.push({ discountType: { in: [DiscountType.percentage, DiscountType.fixed_amount] } });
    if (filter.batchId) and.push({ batchId: filter.batchId });
    const q = filter.q?.trim();
    if (q) and.push({ OR: [{ code: { contains: q.toUpperCase() } }, { label: { contains: q, mode: 'insensitive' } }] });
    if (and.length > 0) where.AND = and;
    return where;
  }

  /** The row as it will be once `patch` lands, with every rule on a single value checked. */
  private merged(row: Row | null, patch: CouponFields): Row {
    const next: Row = {};
    for (const k of [...PLAIN_COLUMNS, ...DECIMAL_COLUMNS, ...DATE_COLUMNS]) {
      next[k] = patch[k] !== undefined ? patch[k] : row ? row[k] : undefined;
    }
    next['code'] = String(next['code'] ?? '').trim().toUpperCase();
    if (!CODE.test(next['code'] as string)) throw new CouponAdminRefused('invalid_code');
    next['visibility'] ??= CouponVisibility.public;
    next['perUserUsageLimit'] ??= 1;
    next['isActive'] ??= true;
    next['activeWeekdays'] ??= [];
    next['allowedChannels'] ??= [];
    next['firstPurchaseOnly'] ??= false;
    for (const k of ['label', 'note'] as const) {
      const v = typeof next[k] === 'string' ? (next[k] as string).trim() : null;
      next[k] = v ? v : null;
    }

    const type = next['discountType'] as string;
    if (!(type in DiscountType)) throw new CouponAdminRefused('invalid_value', 'discountType');
    if (!((next['visibility'] as string) in CouponVisibility)) throw new CouponAdminRefused('invalid_value', 'visibility');
    const value = dec(next['discountValue']);
    if (!value || !value.isPositive() || value.isZero()) throw new CouponAdminRefused('invalid_value', 'discountValue');
    if (type === DiscountType.percentage && value.greaterThan(100)) throw new CouponAdminRefused('invalid_value', 'a percentage is at most 100');
    const cap = dec(next['maxDiscountCap']);
    if (cap && (type !== DiscountType.percentage || !cap.isPositive() || cap.isZero())) throw new CouponAdminRefused('invalid_value', 'maxDiscountCap');

    if (type === DiscountType.wallet_credit) {
      for (const k of NOT_FOR_GIFT_CODES) if (next[k] !== null && next[k] !== undefined) throw new CouponAdminRefused('limits_not_for_gift_codes', k);
      if ((next['activeWeekdays'] as unknown[]).length > 0 || (next['allowedChannels'] as unknown[]).length > 0 || next['firstPurchaseOnly'] === true) {
        throw new CouponAdminRefused('limits_not_for_gift_codes');
      }
      if ((patch.gateways?.length ?? 0) > 0 || (patch.serviceScopes?.length ?? 0) > 0) throw new CouponAdminRefused('limits_not_for_gift_codes');
    }
    this.assertLimits(next);
    return next;
  }

  /** The database's CHECKs (`20260914001100_coupon_limits`), answered as a reason before they fire. */
  private assertLimits(n: Row): void {
    const bad = (what: string) => new CouponAdminRefused('invalid_limit', what);
    const min = dec(n['minPurchaseAmount']);
    const max = dec(n['maxPurchaseAmount']);
    if (min && min.isNegative()) throw bad('minPurchaseAmount');
    if (max && (!max.isPositive() || max.isZero() || (min && max.lessThan(min)))) throw bad('maxPurchaseAmount');
    const total = n['totalUsageLimit'];
    if (total !== null && total !== undefined && (!isInt(total) || total < 1)) throw bad('totalUsageLimit');
    if (!isInt(n['perUserUsageLimit']) || (n['perUserUsageLimit'] as number) < 0) throw bad('perUserUsageLimit');
    const from = date(n['validFrom']);
    const until = date(n['expiresAt']);
    if ((from && Number.isNaN(from.getTime())) || (until && Number.isNaN(until.getTime()))) throw bad('date');
    if (from && until && from >= until) throw bad('validFrom');
    const days = n['activeWeekdays'] as unknown[];
    if (!Array.isArray(days) || days.some((d) => !isInt(d) || d < 1 || d > 7)) throw bad('activeWeekdays');
    const hf = n['activeHourFrom'];
    const ht = n['activeHourTo'];
    if ((hf === null || hf === undefined) !== (ht === null || ht === undefined)) throw bad('activeHours');
    if (hf !== null && hf !== undefined && (!isInt(hf) || !isInt(ht) || hf < 0 || hf > 23 || ht < 1 || ht > 24 || hf === ht)) throw bad('activeHours');
    const nu = n['newUserWithinDays'];
    if (nu !== null && nu !== undefined && (!isInt(nu) || nu <= 0)) throw bad('newUserWithinDays');
    const pl = n['periodUsageLimit'];
    const pd = n['periodDays'];
    if ((pl === null || pl === undefined) !== (pd === null || pd === undefined)) throw bad('period');
    if (pl !== null && pl !== undefined && (!isInt(pl) || !isInt(pd) || pl <= 0 || pd <= 0)) throw bad('period');
    const channels = n['allowedChannels'] as unknown[];
    if (!Array.isArray(channels) || channels.some((c) => !((c as string) in CouponChannel))) throw bad('allowedChannels');
  }

  /**
   * The child sets as they will be, checked against the coupon's tenant: whom
   * it serves, who may use it, which gateways and service scopes. A set not in
   * the patch keeps its current value and is re-checked only when what it
   * depends on moves.
   */
  private async checkRelations(
    actor: CouponActor,
    tenantId: string | null,
    next: Row,
    patch: CouponFields,
    current: Pick<CouponView, 'tenantIds' | 'allowedUserIds' | 'gateways' | 'serviceScopes'>,
  ): Promise<Pick<CouponView, 'tenantIds' | 'allowedUserIds' | 'gateways'> & { serviceScopes: CouponScopeRef[] }> {
    const tenantIds = [...new Set(patch.tenantIds ?? current.tenantIds)];
    const allowedUserIds = [...new Set(patch.allowedUserIds ?? current.allowedUserIds)];
    const gateways = patch.gateways ?? current.gateways;
    const serviceScopes = patch.serviceScopes ?? current.serviceScopes;

    if (tenantId !== null && tenantIds.length > 0) throw new CouponAdminRefused('tenants_are_platform_coupons');
    if (patch.tenantIds !== undefined && tenantIds.length > 0) {
      const found = await this.all.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true } });
      const missing = tenantIds.find((t) => !found.some((f) => f.id === t));
      if (missing) throw new CouponAdminRefused('tenant_not_found', missing);
    }

    if (next['visibility'] === CouponVisibility.targeted && allowedUserIds.length === 0) throw new CouponAdminRefused('targeted_needs_users');
    if (allowedUserIds.length > 0 && (patch.allowedUserIds !== undefined || patch.tenantIds !== undefined)) {
      // ADR-0048: a platform coupon naming no tenant serves the platform owner's
      // users — the caller, since only the platform owner writes one.
      const served = tenantId !== null ? [tenantId] : tenantIds.length > 0 ? tenantIds : [actor.tenantId];
      const users = await this.all.user.findMany({ where: { id: { in: allowedUserIds } }, select: { id: true, tenantId: true } });
      for (const id of allowedUserIds) {
        const u = users.find((x) => x.id === id);
        if (!u || !served.includes(u.tenantId)) throw new CouponAdminRefused('user_out_of_scope', id);
      }
    }

    if (patch.gateways !== undefined) {
      const seen = new Set<string>();
      for (const g of gateways) {
        const key = `${g.source}:${g.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await this.assertGateway(tenantId, g);
      }
    }

    if (patch.serviceScopes !== undefined) {
      for (const s of serviceScopes) {
        const plan = s.servicePlanId ?? null;
        const category = s.categoryId ?? null;
        if ((plan === null) === (category === null)) throw new CouponAdminRefused('scope_not_found', 'a scope names one plan or one category');
        const found = plan
          ? await this.all.servicePlan.findUnique({ where: { id: plan }, select: { tenantId: true } })
          : await this.all.productCategory.findUnique({ where: { id: category as string }, select: { tenantId: true } });
        if (!found || (found.tenantId !== null && found.tenantId !== tenantId)) throw new CouponAdminRefused('scope_not_found', plan ?? category ?? '');
      }
    }
    return { tenantIds, allowedUserIds, gateways, serviceScopes };
  }

  /**
   * A gateway the coupon's payers can meet. A platform coupon: a platform
   * gateway (ADR-0048 decision 4). A tenant coupon: its own gateway, or one
   * granted to it (ADR-0041).
   */
  private async assertGateway(tenantId: string | null, g: CouponGatewayRef): Promise<void> {
    if (tenantId === null) {
      if (g.source !== 'platform') throw new CouponAdminRefused('platform_coupon_needs_platform_gateway', g.id);
      if (!(await this.all.paymentGateway.findUnique({ where: { id: g.id }, select: { id: true } }))) throw new CouponAdminRefused('gateway_not_found', g.id);
      return;
    }
    if (g.source === 'tenant') {
      const own = await this.all.tenantGatewayConfig.findUnique({ where: { id: g.id }, select: { tenantId: true } });
      if (own?.tenantId === tenantId) return;
      if (own && (await this.all.paymentGatewayGrant.findFirst({ where: { tenantId, tenantGatewayConfigId: g.id, isActive: true }, select: { id: true } }))) return;
      throw new CouponAdminRefused('gateway_not_found', g.id);
    }
    const grant = await this.all.paymentGatewayGrant.findFirst({ where: { tenantId, gatewayId: g.id, isActive: true }, select: { id: true } });
    if (!grant) throw new CouponAdminRefused('gateway_not_found', g.id);
  }

  /** The partial unique indexes, answered as a reason. The index still decides a race. */
  private async assertCodeFree(tx: Tx, tenantId: string | null, code: string, exceptId: string | null): Promise<void> {
    const taken = await tx.coupon.findFirst({ where: { tenantId, code, deletedAt: null }, select: { id: true } });
    if (taken && taken.id !== exceptId) throw new CouponAdminRefused('code_taken', code);
  }

  private async writeRelations(
    tx: Tx,
    couponId: string,
    rel: Pick<CouponView, 'tenantIds' | 'allowedUserIds' | 'gateways'> & { serviceScopes: CouponScopeRef[] },
    patch: CouponFields,
    replace = false,
  ): Promise<void> {
    if (patch.tenantIds !== undefined) {
      if (replace) await tx.couponTenant.deleteMany({ where: { couponId } });
      if (rel.tenantIds.length) await tx.couponTenant.createMany({ data: rel.tenantIds.map((tenantId) => ({ couponId, tenantId })) });
    }
    if (patch.allowedUserIds !== undefined) {
      if (replace) await tx.couponAllowedUser.deleteMany({ where: { couponId } });
      if (rel.allowedUserIds.length) await tx.couponAllowedUser.createMany({ data: rel.allowedUserIds.map((userId) => ({ couponId, userId })) });
    }
    if (patch.gateways !== undefined) {
      if (replace) await tx.couponGateway.deleteMany({ where: { couponId } });
      const unique = [...new Map(rel.gateways.map((g) => [`${g.source}:${g.id}`, g])).values()];
      if (unique.length) {
        await tx.couponGateway.createMany({
          data: unique.map((g) => (g.source === 'platform' ? { couponId, gatewayId: g.id } : { couponId, tenantGatewayConfigId: g.id })),
        });
      }
    }
    if (patch.serviceScopes !== undefined) {
      if (replace) await tx.couponServiceScope.deleteMany({ where: { couponId } });
      if (rel.serviceScopes.length) {
        await tx.couponServiceScope.createMany({
          data: rel.serviceScopes.map((s) => ({ couponId, servicePlanId: s.servicePlanId ?? null, categoryId: s.categoryId ?? null })),
        });
      }
    }
  }

  /** The storable columns of a merged row. */
  private columns(next: Row): Row {
    const data: Row = {};
    for (const k of PLAIN_COLUMNS) if (next[k] !== undefined) data[k] = next[k];
    for (const k of DECIMAL_COLUMNS) if (next[k] !== undefined) data[k] = dec(next[k]);
    for (const k of DATE_COLUMNS) if (next[k] !== undefined) data[k] = date(next[k]);
    return data;
  }

  /** A view without its counters and clocks: what an audit row compares. */
  private snapshot(view: CouponView): Record<string, unknown> {
    const out: Record<string, unknown> = { ...view };
    for (const k of ['id', 'usedCount', 'reservedCount', 'createdAt', 'updatedAt', 'status']) delete out[k];
    for (const k of DATE_COLUMNS) out[k] = view[k] ? view[k]!.toISOString() : null;
    for (const k of DECIMAL_COLUMNS) out[k] = view[k] === null ? null : new Prisma.Decimal(view[k]!).toFixed(2);
    out['deletedAt'] = view.deletedAt ? view.deletedAt.toISOString() : null;
    return out;
  }
}

/** What an admin sees at a glance; the first that holds wins. */
export function statusOf(row: Row, now: number): CouponStatus {
  if (row['deletedAt'] != null) return 'deleted';
  if (!row['isActive']) return 'inactive';
  const until = date(row['expiresAt']);
  if (until && until.getTime() <= now) return 'expired';
  const from = date(row['validFrom']);
  if (from && from.getTime() > now) return 'scheduled';
  const total = row['totalUsageLimit'] as number | null | undefined;
  if (total !== null && total !== undefined && Number(row['usedCount'] ?? 0) + Number(row['reservedCount'] ?? 0) >= total) return 'exhausted';
  return 'active';
}
