import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { LotteryEntryMode, LotteryStatus, Prisma, SpinPrizeType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { missingPrizeRelation, prizeShapeOk } from './prize-shape';

/**
 * A tenant's lotteries (F-707-i, ADR-0111 points 5, 6):
 * `/api/billing/engagement/lotteries`.
 *
 * **A draft is edited freely; a published lottery is not edited at all.**
 * Publishing fixes the group, the prizes, the close time and the eligibility
 * rules, so users enter knowing what they enter for and an admin cannot move
 * them once the entrant list starts to form. From then on only the close job
 * (F-707-k) moves it on, or a cancel with a public reason — and not after the
 * freeze, when the list is fixed and the seed about to exist. The database
 * holds the same rules (`lottery_status_one_way`, `lottery_frozen`,
 * `lottery_cancel_reason`); this answers them with a reason.
 *
 * Every state change is a conditional write on the status, so two admins, or
 * an admin and the close job, cannot both act on one lottery.
 *
 * Every row is the caller's own tenant's (RLS); a group, a coupon template
 * and a variant must be ones it can see. No cash, no empty prize (point 2).
 */

export type LotteryAdminRejection =
  | 'invalid_prize'
  | 'invalid_close_time'
  | 'cancel_reason_required'
  | 'coupon_template_not_found'
  | 'variant_not_found'
  | 'group_not_found'
  | 'lottery_not_found'
  | 'not_a_draft'
  | 'not_cancellable'
  /** The winners are asked for before the draw (F-707-o). */
  | 'not_drawn';

export class LotteryAdminRefused extends Error {
  constructor(
    readonly reason: LotteryAdminRejection,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'LotteryAdminRefused';
  }
}

export type LotteryActor = { adminId: string; tenantId: string; ip: string };

export type LotteryPrizeInput = {
  label: string;
  prizeType: SpinPrizeType;
  /** A decimal string (C-02): GB, whole days, or a coupon's percent; 0 for a free Grant. */
  prizeValue: string;
  couponTemplateId?: string | null;
  couponValidDays?: number | null;
  variantId?: string | null;
  winnersCount: number;
};

export type LotteryDraftInput = {
  userGroupId: string;
  title: string;
  description?: string | null;
  entryMode: LotteryEntryMode;
  /** An instant (ISO 8601). */
  closesAt: string;
  requiresPhoneVerified?: boolean;
  requiresMinAccountAgeHours?: number;
  /** Places drawn after the winners, in order: who takes a prize a winner can no longer receive (F-707-m). */
  reservesCount?: number;
  /** In rank order: the first is rank 1. */
  prizes: LotteryPrizeInput[];
};

export type LotteryPrizeView = {
  id: string;
  rank: number;
  label: string;
  prizeType: SpinPrizeType;
  prizeValue: string;
  couponTemplateId: string | null;
  couponValidDays: number | null;
  variantId: string | null;
  winnersCount: number;
};

export type LotteryView = {
  id: string;
  status: LotteryStatus;
  userGroupId: string;
  title: string;
  description: string | null;
  entryMode: LotteryEntryMode;
  closesAt: Date;
  requiresPhoneVerified: boolean;
  requiresMinAccountAgeHours: number;
  reservesCount: number;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  /** Public: users are told why (point 5). */
  cancelReason: string | null;
  createdByAdminId: string;
  createdAt: Date;
  /** Rows in the entrant list so far: opt-ins while open; every ticket holder and excluded member after the freeze. */
  entrantCount: number;
  /** Σ winnersCount. */
  winnersTotal: number;
  prizes: LotteryPrizeView[];
};

type PrizeRow = {
  id: string;
  rank: number;
  label: string;
  prizeType: SpinPrizeType;
  prizeValue: Prisma.Decimal;
  couponTemplateId: string | null;
  couponValidDays: number | null;
  variantId: string | null;
  winnersCount: number;
};
type LotteryRow = Omit<LotteryView, 'entrantCount' | 'winnersTotal' | 'prizes'> & { prizes: PrizeRow[]; _count: { entrants: number } };

/** The clock, injectable so a spec can stand at a close time. */
export const LOTTERY_CLOCK = Symbol('LOTTERY_CLOCK');

/** Users need time to see it and opt in: a close time at least this far ahead, at save and at publish. */
export const LOTTERY_MIN_OPEN_MS = 60 * 60 * 1000;
/** And not so far that a prize outlives the offer behind it. */
export const LOTTERY_MAX_OPEN_MS = 180 * 24 * 60 * 60 * 1000;

const WITH_PARTS = { prizes: true, _count: { select: { entrants: true } } } as const;

function decimal(v: string): Prisma.Decimal {
  try {
    const d = new Prisma.Decimal(v);
    if (d.isNegative() || d.decimalPlaces() > 2) throw new Error();
    return d;
  } catch {
    throw new LotteryAdminRefused('invalid_prize', v);
  }
}

function viewOf(row: LotteryRow): LotteryView {
  const { prizes, _count, ...rest } = row;
  const ranked = [...prizes].sort((a, b) => a.rank - b.rank);
  return {
    id: rest.id,
    status: rest.status,
    userGroupId: rest.userGroupId,
    title: rest.title,
    description: rest.description,
    entryMode: rest.entryMode,
    closesAt: rest.closesAt,
    requiresPhoneVerified: rest.requiresPhoneVerified,
    requiresMinAccountAgeHours: rest.requiresMinAccountAgeHours,
    reservesCount: rest.reservesCount,
    publishedAt: rest.publishedAt,
    cancelledAt: rest.cancelledAt,
    cancelReason: rest.cancelReason,
    createdByAdminId: rest.createdByAdminId,
    createdAt: rest.createdAt,
    entrantCount: _count.entrants,
    winnersTotal: ranked.reduce((s, p) => s + p.winnersCount, 0),
    prizes: ranked.map((p) => ({
      id: p.id,
      rank: p.rank,
      label: p.label,
      prizeType: p.prizeType,
      prizeValue: new Prisma.Decimal(p.prizeValue).toFixed(2),
      couponTemplateId: p.couponTemplateId,
      couponValidDays: p.couponValidDays,
      variantId: p.variantId,
      winnersCount: p.winnersCount,
    })),
  };
}

/** What the audit row records of a lottery: the view without its ids and counters. */
function auditValue(v: LotteryView): Prisma.InputJsonValue {
  const { id: _id, createdAt: _c, entrantCount: _e, prizes, ...rest } = v;
  return { ...rest, prizes: prizes.map(({ id: _p, ...p }) => p) } as unknown as Prisma.InputJsonValue;
}

@Injectable()
export class LotteryAdminService {
  private readonly logger = new Logger(LotteryAdminService.name);
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(LOTTERY_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** Every lottery of the tenant, newest first. */
  list(actor: LotteryActor): Promise<LotteryView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = (await tx.lottery.findMany({ where: { tenantId: actor.tenantId }, include: WITH_PARTS, orderBy: { createdAt: 'desc' } })) as unknown as LotteryRow[];
      return rows.map(viewOf);
    });
  }

  get(actor: LotteryActor, id: string): Promise<LotteryView> {
    return tenantTransaction(this.prisma, (tx) => this.read(tx, actor.tenantId, id));
  }

  create(actor: LotteryActor, input: LotteryDraftInput): Promise<LotteryView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { fields, prizes } = await this.checked(tx, actor.tenantId, input);
      const row = await tx.lottery.create({ data: { tenantId: actor.tenantId, ...fields, createdByAdminId: actor.adminId }, select: { id: true } });
      await this.writePrizes(tx, actor.tenantId, row.id, prizes);
      const view = await this.read(tx, actor.tenantId, row.id);
      await this.audit(tx, actor, 'lottery_create', row.id, null, auditValue(view));
      this.logger.log(`lottery ${row.id} drafted by ${actor.adminId}`);
      return view;
    });
  }

  /** A draft rewritten whole, prizes too. A published lottery is fixed (point 5). */
  replace(actor: LotteryActor, id: string, input: LotteryDraftInput): Promise<LotteryView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const before = await this.read(tx, actor.tenantId, id);
      if (before.status !== LotteryStatus.draft) throw new LotteryAdminRefused('not_a_draft', before.status);
      const { fields, prizes } = await this.checked(tx, actor.tenantId, input);
      // Conditional on the status: a publish that won the race leaves this one nothing to write.
      const { count } = await tx.lottery.updateMany({ where: { id, tenantId: actor.tenantId, status: LotteryStatus.draft }, data: fields });
      if (count === 0) throw await this.why(tx, actor.tenantId, id, 'not_a_draft');
      await tx.lotteryPrize.deleteMany({ where: { lotteryId: id } });
      await this.writePrizes(tx, actor.tenantId, id, prizes);
      const view = await this.read(tx, actor.tenantId, id);
      await this.audit(tx, actor, 'lottery_update', id, auditValue(before), auditValue(view));
      return view;
    });
  }

  /** Only a draft is deleted; a published lottery is cancelled with a reason. */
  remove(actor: LotteryActor, id: string): Promise<void> {
    return tenantTransaction(this.prisma, async (tx) => {
      const before = await this.read(tx, actor.tenantId, id);
      const { count } = await tx.lottery.deleteMany({ where: { id, tenantId: actor.tenantId, status: LotteryStatus.draft } });
      if (count === 0) throw await this.why(tx, actor.tenantId, id, 'not_a_draft');
      await this.audit(tx, actor, 'lottery_delete', id, auditValue(before), null);
    });
  }

  /** Opens a draft: from now its prizes, times, group and rules are fixed, and users may enter. */
  publish(actor: LotteryActor, id: string): Promise<LotteryView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const before = await this.read(tx, actor.tenantId, id);
      if (before.status !== LotteryStatus.draft) throw new LotteryAdminRefused('not_a_draft', before.status);
      const now = this.now();
      this.checkCloseTime(before.closesAt, now);
      await this.checkGroup(tx, before.userGroupId);
      // The close-time bound rides in the write, so a draft edited after the read is judged as written.
      const { count } = await tx.lottery.updateMany({
        where: { id, tenantId: actor.tenantId, status: LotteryStatus.draft, closesAt: { gte: new Date(now.getTime() + LOTTERY_MIN_OPEN_MS) } },
        data: { status: LotteryStatus.published, publishedAt: now },
      });
      if (count === 0) throw await this.why(tx, actor.tenantId, id, 'not_a_draft');
      const view = await this.read(tx, actor.tenantId, id);
      await this.audit(tx, actor, 'lottery_publish', id, { status: before.status }, auditValue(view));
      this.logger.log(`lottery ${id} published by ${actor.adminId}, closes ${view.closesAt.toISOString()}`);
      return view;
    });
  }

  /** From a draft or while open, with a reason users are shown. Never after the freeze. */
  cancel(actor: LotteryActor, id: string, reason: string): Promise<LotteryView> {
    const why = reason.trim();
    return tenantTransaction(this.prisma, async (tx) => {
      if (why.length === 0) throw new LotteryAdminRefused('cancel_reason_required');
      const before = await this.read(tx, actor.tenantId, id);
      const { count } = await tx.lottery.updateMany({
        where: { id, tenantId: actor.tenantId, status: { in: [LotteryStatus.draft, LotteryStatus.published] } },
        data: { status: LotteryStatus.cancelled, cancelledAt: this.now(), cancelReason: why },
      });
      if (count === 0) throw await this.why(tx, actor.tenantId, id, 'not_cancellable');
      const view = await this.read(tx, actor.tenantId, id);
      await this.audit(tx, actor, 'lottery_cancel', id, { status: before.status }, { status: view.status, cancelReason: why });
      this.logger.log(`lottery ${id} cancelled by ${actor.adminId} from ${before.status}`);
      return view;
    });
  }

  private async read(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<LotteryView> {
    const row = (await tx.lottery.findFirst({ where: { id, tenantId }, include: WITH_PARTS })) as unknown as LotteryRow | null;
    if (!row) throw new LotteryAdminRefused('lottery_not_found', id);
    return viewOf(row);
  }

  /** A conditional write matched nothing: gone, or no longer in a state that allows it. */
  private async why(tx: Prisma.TransactionClient, tenantId: string, id: string, otherwise: LotteryAdminRejection): Promise<LotteryAdminRefused> {
    const row = await tx.lottery.findFirst({ where: { id, tenantId }, include: WITH_PARTS });
    if (!row) return new LotteryAdminRefused('lottery_not_found', id);
    if (otherwise === 'not_a_draft' && row.status === LotteryStatus.draft) return new LotteryAdminRefused('invalid_close_time', row.closesAt.toISOString());
    return new LotteryAdminRefused(otherwise, row.status);
  }

  private checkCloseTime(closesAt: Date, now: Date): void {
    const ahead = closesAt.getTime() - now.getTime();
    if (!Number.isFinite(ahead) || ahead < LOTTERY_MIN_OPEN_MS || ahead > LOTTERY_MAX_OPEN_MS) {
      throw new LotteryAdminRefused('invalid_close_time', Number.isFinite(ahead) ? closesAt.toISOString() : 'not a time');
    }
  }

  private async checkGroup(tx: Prisma.TransactionClient, groupId: string): Promise<void> {
    // RLS: another tenant's group is simply not found.
    const g = await tx.userGroup.findUnique({ where: { id: groupId }, select: { id: true } });
    if (!g) throw new LotteryAdminRefused('group_not_found', groupId);
  }

  private async checked(tx: Prisma.TransactionClient, tenantId: string, input: LotteryDraftInput) {
    const prizes = input.prizes.map((p) => {
      const value = decimal(p.prizeValue);
      // A lottery never draws "nothing": every place drawn is a prize.
      if (p.prizeType === SpinPrizeType.empty || !prizeShapeOk({ ...p, prizeValue: value }) || !Number.isInteger(p.winnersCount) || p.winnersCount < 1) {
        throw new LotteryAdminRefused('invalid_prize', `${p.prizeType} "${p.label}"`);
      }
      return { p, value };
    });
    const closesAt = new Date(input.closesAt);
    this.checkCloseTime(closesAt, this.now());
    const missing = await missingPrizeRelation(tx, tenantId, input.prizes);
    if (missing) throw new LotteryAdminRefused(missing.reason, missing.id);
    await this.checkGroup(tx, input.userGroupId);
    return {
      fields: {
        userGroupId: input.userGroupId,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        entryMode: input.entryMode,
        closesAt,
        requiresPhoneVerified: input.requiresPhoneVerified ?? true,
        requiresMinAccountAgeHours: input.requiresMinAccountAgeHours ?? 24,
        reservesCount: input.reservesCount ?? 0,
      },
      prizes,
    };
  }

  private async writePrizes(tx: Prisma.TransactionClient, tenantId: string, lotteryId: string, prizes: Array<{ p: LotteryPrizeInput; value: Prisma.Decimal }>) {
    await tx.lotteryPrize.createMany({
      data: prizes.map(({ p, value }, i) => ({
        tenantId,
        lotteryId,
        rank: i + 1,
        label: p.label.trim(),
        prizeType: p.prizeType,
        prizeValue: value.toFixed(2),
        couponTemplateId: p.couponTemplateId ?? null,
        couponValidDays: p.couponValidDays ?? null,
        variantId: p.variantId ?? null,
        winnersCount: p.winnersCount,
      })),
    });
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: LotteryActor,
    action: 'lottery_create' | 'lottery_update' | 'lottery_delete' | 'lottery_publish' | 'lottery_cancel',
    lotteryId: string,
    oldValue: Prisma.InputJsonValue | null,
    newValue: Prisma.InputJsonValue | null,
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        tenantId: actor.tenantId,
        adminId: actor.adminId,
        action,
        targetEntityType: 'lottery',
        targetEntityId: lotteryId,
        oldValue: oldValue ?? Prisma.DbNull,
        newValue: newValue ?? Prisma.DbNull,
        adminIpAddress: actor.ip,
      },
    });
  }
}
