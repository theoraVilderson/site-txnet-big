import { randomInt } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { CouponVisibility, DiscountType, Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { CouponActor, CouponAdminRefused, CouponAdminService, statusOf } from './coupon-admin.service';

/** No 0/O, no 1/I/L: a code is read off a card and typed by a person. */
export const GIFT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GIFT_BATCH_MAX = 5000;
const BODY_LENGTH = 10;
const PREFIX = /^[A-Z0-9]{1,8}$/;
const DRAW_ROUNDS = 8;
const CHUNK = 1000;

export type GenerateBatchInput = {
  /** Absent = the caller's tenant; `null` = a platform batch (the platform owner's). */
  tenantId?: string | null;
  label: string;
  note?: string | null;
  count: number;
  /** The wallet credit each code gives, base currency (C-02). */
  value: string;
  /** Upper-cased and joined with a dash: `YLD-7KQ2M9XHRT`. */
  prefix?: string | null;
  expiresAt?: string | Date | null;
  /** Platform batches only: the tenants whose users may redeem (ADR-0048 decision 2). */
  tenantIds?: string[];
};

export type BatchView = {
  id: string;
  tenantId: string | null;
  label: string;
  note: string | null;
  createdAt: Date;
  deactivatedAt: Date | null;
  codes: number;
  used: number;
  reserved: number;
};

type Row = Record<string, unknown>;

/**
 * Gift-code batches (F-502-d, D-33, ADR-0048 decision 7). Ownership is
 * `CouponAdminService`'s; this adds what only a batch has.
 *
 * **A code is a bearer credit.** It is drawn from `crypto.randomInt` over
 * {@link GIFT_CODE_ALPHABET} (31^10 ≈ 8·10^14 per prefix), never written to an
 * audit row or a log, and exporting a batch is audited as its own act.
 *
 * **Collisions are drawn again**, against live codes in the same scope and
 * inside the batch, for up to {@link DRAW_ROUNDS} rounds; the partial unique
 * index still decides a race, and the whole insert rolls back with it.
 */
@Injectable()
export class CouponBatchService {
  private readonly logger = new Logger(CouponBatchService.name);

  constructor(
    private readonly coupons: CouponAdminService,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async generate(actor: CouponActor, input: GenerateBatchInput): Promise<BatchView> {
    const tenantId = await this.coupons.ownerOfNew(actor, input.tenantId);
    const count = input.count;
    if (!Number.isInteger(count) || count < 1 || count > GIFT_BATCH_MAX) throw new CouponAdminRefused('invalid_batch', `count 1..${GIFT_BATCH_MAX}`);
    const label = input.label?.trim();
    if (!label) throw new CouponAdminRefused('invalid_batch', 'label');
    const prefix = input.prefix?.trim().toUpperCase() || null;
    if (prefix !== null && !PREFIX.test(prefix)) throw new CouponAdminRefused('invalid_code', 'prefix');
    let value: Prisma.Decimal;
    try {
      value = new Prisma.Decimal(input.value);
    } catch {
      throw new CouponAdminRefused('invalid_value', 'value');
    }
    if (!value.isPositive() || value.isZero() || value.decimalPlaces() > 2) throw new CouponAdminRefused('invalid_value', 'value');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new CouponAdminRefused('invalid_limit', 'expiresAt');
    const tenantIds = [...new Set(input.tenantIds ?? [])];
    if (tenantId !== null && tenantIds.length > 0) throw new CouponAdminRefused('tenants_are_platform_coupons');
    if (tenantIds.length > 0) {
      const found = await this.all.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true } });
      const missing = tenantIds.find((t) => !found.some((f) => f.id === t));
      if (missing) throw new CouponAdminRefused('tenant_not_found', missing);
    }

    const batch = await this.all.$transaction(
      async (tx) => {
        const codes = await this.draw(tx, tenantId, prefix, count);
        const row = await tx.couponBatch.create({ data: { tenantId, label, note: input.note?.trim() || null, createdByAdminId: actor.adminId } });
        for (let i = 0; i < codes.length; i += CHUNK) {
          await tx.coupon.createMany({
            data: codes.slice(i, i + CHUNK).map((code) => ({
              tenantId,
              code,
              discountType: DiscountType.wallet_credit,
              discountValue: value,
              totalUsageLimit: 1,
              perUserUsageLimit: 1,
              expiresAt,
              isActive: true,
              visibility: CouponVisibility.public,
              batchId: row.id,
              createdByAdminId: actor.adminId,
            })),
          });
        }
        if (tenantIds.length > 0) {
          const created = await tx.coupon.findMany({ where: { batchId: row.id }, select: { id: true } });
          for (let i = 0; i < created.length; i += CHUNK) {
            await tx.couponTenant.createMany({ data: created.slice(i, i + CHUNK).flatMap((c) => tenantIds.map((t) => ({ couponId: c.id, tenantId: t }))) });
          }
        }
        await tx.adminAuditLog.create({
          data: {
            tenantId: tenantId ?? actor.tenantId,
            adminId: actor.adminId,
            action: 'coupon_batch_create',
            targetEntityType: 'coupon_batch',
            targetEntityId: row.id,
            oldValue: Prisma.DbNull,
            // The count and the terms — never a code.
            newValue: { label, count, value: value.toFixed(2), prefix, expiresAt: expiresAt?.toISOString() ?? null, tenantIds },
            adminIpAddress: actor.ip,
          },
        });
        return row as unknown as Row;
      },
      { timeout: 60_000 },
    );
    this.logger.log(`coupon batch ${batch['id']} (${count} codes) created by ${actor.adminId}`);
    return this.view(batch, { codes: count, used: 0, reserved: 0 });
  }

  async list(actor: CouponActor, filter: { tenantId?: string; page?: number; pageSize?: number }): Promise<{ items: BatchView[]; total: number; page: number; pageSize: number }> {
    const { owner } = await this.coupons.access(actor);
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize ?? 20)));
    const where: Prisma.CouponBatchWhereInput = !owner
      ? { tenantId: actor.tenantId }
      : filter.tenantId === 'platform'
        ? { tenantId: null }
        : filter.tenantId
          ? { tenantId: filter.tenantId }
          : {};
    const [rows, total] = await Promise.all([
      this.all.couponBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.all.couponBatch.count({ where }),
    ]);
    const counts = await this.counts(rows.map((r) => r.id));
    return { items: rows.map((r) => this.view(r as unknown as Row, counts.get(r.id))), total, page, pageSize };
  }

  async get(actor: CouponActor, id: string): Promise<BatchView> {
    const row = await this.load(actor, id);
    return this.view(row, (await this.counts([id])).get(id));
  }

  /** The batch's codes as CSV (RFC 4180 line ends). Audited: whoever holds this file holds the credit. */
  async exportCsv(actor: CouponActor, id: string): Promise<string> {
    const batch = await this.load(actor, id);
    const rows = (await this.all.coupon.findMany({
      where: { batchId: id, deletedAt: null },
      orderBy: { code: 'asc' },
      select: { code: true, discountValue: true, expiresAt: true, isActive: true, usedCount: true, reservedCount: true, totalUsageLimit: true, validFrom: true, deletedAt: true },
    })) as unknown as Row[];
    const now = Date.now();
    const lines = ['code,value,expires_at,status,used'];
    for (const r of rows) {
      const expires = r['expiresAt'] ? new Date(r['expiresAt'] as Date).toISOString() : '';
      lines.push([r['code'], new Prisma.Decimal(String(r['discountValue'])).toFixed(2), expires, statusOf(r, now), Number(r['usedCount'] ?? 0)].join(','));
    }
    await this.all.adminAuditLog.create({
      data: {
        tenantId: (batch['tenantId'] as string | null) ?? actor.tenantId,
        adminId: actor.adminId,
        action: 'coupon_batch_export',
        targetEntityType: 'coupon_batch',
        targetEntityId: id,
        oldValue: Prisma.DbNull,
        newValue: { codes: rows.length },
        adminIpAddress: actor.ip,
      },
    });
    return lines.join('\r\n') + '\r\n';
  }

  /** Switch the whole batch off: every live code, and the batch's own mark. Repeating it is harmless. */
  async deactivate(actor: CouponActor, id: string): Promise<{ id: string; deactivated: number }> {
    const batch = await this.load(actor, id);
    const deactivated = await this.all.$transaction(async (tx) => {
      const { count } = await tx.coupon.updateMany({ where: { batchId: id, deletedAt: null, isActive: true }, data: { isActive: false } });
      if (!batch['deactivatedAt']) await tx.couponBatch.update({ where: { id }, data: { deactivatedAt: new Date() } });
      await tx.adminAuditLog.create({
        data: {
          tenantId: (batch['tenantId'] as string | null) ?? actor.tenantId,
          adminId: actor.adminId,
          action: 'coupon_batch_deactivate',
          targetEntityType: 'coupon_batch',
          targetEntityId: id,
          oldValue: { deactivatedAt: batch['deactivatedAt'] ? new Date(batch['deactivatedAt'] as Date).toISOString() : null },
          newValue: { deactivated: count },
          adminIpAddress: actor.ip,
        },
      });
      return count;
    });
    this.logger.log(`coupon batch ${id}: ${deactivated} codes switched off by ${actor.adminId}`);
    return { id, deactivated };
  }

  /** The batch, if the caller may manage it. */
  async load(actor: CouponActor, id: string): Promise<Row> {
    const { owner } = await this.coupons.access(actor);
    const row = (await this.all.couponBatch.findUnique({ where: { id } })) as unknown as Row | null;
    if (!row || (!owner && row['tenantId'] !== actor.tenantId)) throw new CouponAdminRefused('batch_not_found', id);
    return row;
  }

  /** One code's random part. Its own method so a test can force a collision. */
  protected randomBody(): string {
    let out = '';
    for (let i = 0; i < BODY_LENGTH; i++) out += GIFT_CODE_ALPHABET[randomInt(GIFT_CODE_ALPHABET.length)];
    return out;
  }

  private async draw(tx: Prisma.TransactionClient, tenantId: string | null, prefix: string | null, count: number): Promise<string[]> {
    const chosen = new Set<string>();
    for (let round = 0; round < DRAW_ROUNDS && chosen.size < count; round++) {
      const candidates = new Set<string>();
      const missing = count - chosen.size;
      for (let i = 0; i < missing; i++) {
        const code = prefix ? `${prefix}-${this.randomBody()}` : this.randomBody();
        if (!chosen.has(code)) candidates.add(code);
      }
      const list = [...candidates];
      const taken = new Set<string>();
      for (let i = 0; i < list.length; i += CHUNK) {
        const hits = await tx.coupon.findMany({ where: { tenantId, code: { in: list.slice(i, i + CHUNK) }, deletedAt: null }, select: { code: true } });
        hits.forEach((h) => taken.add(h.code));
      }
      for (const code of list) if (!taken.has(code)) chosen.add(code);
    }
    if (chosen.size < count) throw new CouponAdminRefused('invalid_batch', 'could not draw enough distinct codes');
    return [...chosen];
  }

  private async counts(ids: string[]): Promise<Map<string, { codes: number; used: number; reserved: number }>> {
    const out = new Map<string, { codes: number; used: number; reserved: number }>();
    if (ids.length === 0) return out;
    const groups = await this.all.coupon.groupBy({
      by: ['batchId'],
      where: { batchId: { in: ids }, deletedAt: null },
      _count: { _all: true },
      _sum: { usedCount: true, reservedCount: true },
    });
    for (const g of groups) {
      out.set(g.batchId as string, { codes: g._count._all, used: g._sum.usedCount ?? 0, reserved: g._sum.reservedCount ?? 0 });
    }
    return out;
  }

  private view(row: Row, counts?: { codes: number; used: number; reserved: number }): BatchView {
    return {
      id: row['id'] as string,
      tenantId: (row['tenantId'] as string | null) ?? null,
      label: row['label'] as string,
      note: (row['note'] as string | null) ?? null,
      createdAt: row['createdAt'] as Date,
      deactivatedAt: (row['deactivatedAt'] as Date | null) ?? null,
      codes: counts?.codes ?? 0,
      used: counts?.used ?? 0,
      reserved: counts?.reserved ?? 0,
    };
  }
}
