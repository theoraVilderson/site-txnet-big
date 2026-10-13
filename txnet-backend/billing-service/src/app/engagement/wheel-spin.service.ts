import { randomInt, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { FraudSubjectType, GrantStatus, InvoiceStatus, Prisma, RewardSource, SpinAttemptStatus, SpinPrizeType, UserStatus } from '@prisma/client';
import { liveMembership, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { GrantService } from '../entitlement/grant';
import { accountsOnFingerprint, FINGERPRINT_FREE_GRANTS_REFUSED_AT, fingerprintHash, fingerprintVerdict, FingerprintSource, recordFingerprint } from '../fraud/device-fingerprint';
import { PrismaService } from '../prisma/prisma.service';
import { issueReward, RewardIssued, RewardRefused } from './reward-issuer';
import { isoDay, tenantDayOf, tenantZoneOf } from './tenant-day';
import { alertCapCrossing } from './wheel-report';

/**
 * The spin (F-707-d, ADR-0111 points 3, 4): `POST /api/billing/wheel/spin`.
 *
 * **The server decides.** The pick is `crypto.randomInt` over the version's
 * weights; the client is told the slot and only animates to it.
 *
 * **One transaction, in this order:**
 * 1. A retried `requestId` answers its recorded attempt and spins nothing.
 * 2. The version in force on the tenant's day; none, or switched off: refused,
 *    nothing recorded (there is no wheel to have spun).
 * 3. The device is recorded and counted (F-036-a); a request whose device
 *    cannot be told is refused before anything is written.
 * 4. The day row is locked `FOR UPDATE` — every spin of the tenant's day
 *    queues on it — and only then are the user's spins today and the cooldown
 *    counted, so two taps cannot both take the last spin.
 * 5. Eligibility is gathered fresh and frozen into the attempt (invariant 3).
 *    A refused spin is recorded too (invariant 2), `voided_fraud` for a shared
 *    device or an open flag, `rejected_ineligible` for the rest.
 * 6. The pick. Over the day's cap, past its stock, or a prize the issuer
 *    refuses (no active service for GB or days) becomes nothing: the issuer
 *    runs inside a savepoint, rolled back on refusal, and the counters are
 *    charged only for a prize actually given. Never cash (point 2).
 * 7. The spin whose prize brings the day to 80% of the cap tells the
 *    tenant's admins, once a day (F-707-e, `alertCapCrossing`).
 */

export type SpinRefusalReason =
  | 'account_inactive'
  | 'account_too_new'
  | 'phone_not_verified'
  | 'no_active_service'
  | 'paid_too_little'
  | 'too_few_orders'
  | 'not_in_group'
  | 'flagged'
  | 'shared_device'
  | 'daily_limit'
  | 'cooldown';

/** Refusals that record nothing: there was no spin to record. */
export type WheelSpinRejection = 'no_wheel' | 'no_fingerprint' | 'spin_in_progress';

export class WheelSpinRefused extends Error {
  constructor(readonly reason: WheelSpinRejection) {
    super(reason);
    this.name = 'WheelSpinRefused';
  }
}

export type SpinPrize = {
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

export type SpinConfig = {
  id: string;
  version: number;
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
  prizes: SpinPrize[];
};

/** What eligibility is decided from, gathered fresh on every spin. */
export type EligibilityFacts = {
  userActive: boolean;
  accountCreatedAt: Date;
  phoneVerified: boolean;
  activeGrants: number;
  /** Paid invoices in the version's currency. */
  totalPaid: Prisma.Decimal;
  paidOrders: number;
  openFraudFlags: number;
  accountsOnFingerprint: number;
  /** Null when the version names no group. */
  inGroup: boolean | null;
  awardedToday: number;
  lastAwardedAt: Date | null;
};

type Check = { ok: boolean; required: unknown; value: unknown };
export type Eligibility = {
  checks: Record<string, Check>;
  refusal: { reason: SpinRefusalReason; status: SpinAttemptStatus } | null;
};

const HOUR_MS = 3_600_000;

/**
 * Every check, in the order a refusal is named. Each is in the snapshot
 * whether or not the version requires it, so a dispute reads what was true.
 */
export function checkEligibility(cfg: SpinConfig, f: EligibilityFacts, at: Date): Eligibility {
  const ageHours = Math.floor((at.getTime() - f.accountCreatedAt.getTime()) / HOUR_MS);
  const nextAt = f.lastAwardedAt ? new Date(f.lastAwardedAt.getTime() + cfg.perUserCooldownHours * HOUR_MS) : null;
  const rows: Array<[string, SpinRefusalReason, SpinAttemptStatus, Check]> = [
    ['accountActive', 'account_inactive', SpinAttemptStatus.rejected_ineligible, { ok: f.userActive, required: true, value: f.userActive }],
    ['accountAge', 'account_too_new', SpinAttemptStatus.rejected_ineligible, { ok: ageHours >= cfg.requiresMinAccountAgeHours, required: cfg.requiresMinAccountAgeHours, value: ageHours }],
    ['phoneVerified', 'phone_not_verified', SpinAttemptStatus.rejected_ineligible, { ok: !cfg.requiresPhoneVerified || f.phoneVerified, required: cfg.requiresPhoneVerified, value: f.phoneVerified }],
    ['activeService', 'no_active_service', SpinAttemptStatus.rejected_ineligible, { ok: !cfg.requiresActiveServiceAtSpinTime || f.activeGrants > 0, required: cfg.requiresActiveServiceAtSpinTime, value: f.activeGrants }],
    ['totalPaid', 'paid_too_little', SpinAttemptStatus.rejected_ineligible, {
      ok: cfg.requiresMinTotalPurchaseAmount === null || f.totalPaid.gte(cfg.requiresMinTotalPurchaseAmount),
      required: cfg.requiresMinTotalPurchaseAmount?.toFixed(2) ?? null,
      value: f.totalPaid.toFixed(2),
    }],
    ['paidOrders', 'too_few_orders', SpinAttemptStatus.rejected_ineligible, { ok: cfg.requiresMinCompletedOrdersCount === null || f.paidOrders >= cfg.requiresMinCompletedOrdersCount, required: cfg.requiresMinCompletedOrdersCount, value: f.paidOrders }],
    ['group', 'not_in_group', SpinAttemptStatus.rejected_ineligible, { ok: cfg.userGroupId === null || f.inGroup === true, required: cfg.userGroupId, value: f.inGroup }],
    ['notFlagged', 'flagged', SpinAttemptStatus.voided_fraud, { ok: f.openFraudFlags === 0, required: 0, value: f.openFraudFlags }],
    ['device', 'shared_device', SpinAttemptStatus.voided_fraud, { ok: fingerprintVerdict(f.accountsOnFingerprint) !== 'refuse_free_grants', required: `< ${FINGERPRINT_FREE_GRANTS_REFUSED_AT}`, value: f.accountsOnFingerprint }],
    ['dailyLimit', 'daily_limit', SpinAttemptStatus.rejected_ineligible, { ok: f.awardedToday < cfg.maxSpinsPerAccountPerDay, required: cfg.maxSpinsPerAccountPerDay, value: f.awardedToday }],
    ['cooldown', 'cooldown', SpinAttemptStatus.rejected_ineligible, { ok: nextAt === null || nextAt.getTime() <= at.getTime(), required: cfg.perUserCooldownHours, value: nextAt?.toISOString() ?? null }],
  ];
  const checks = Object.fromEntries(rows.map(([name, , , c]) => [name, c]));
  const failed = rows.find(([, , , c]) => !c.ok);
  return { checks, refusal: failed ? { reason: failed[1], status: failed[2] } : null };
}

/** The weighted pick: a number below the total weight, walked through the slots in order. */
export function pickSlot<T extends { probabilityWeight: number; position: number }>(prizes: T[], random: (below: number) => number): T {
  const slots = [...prizes].sort((a, b) => a.position - b.position);
  const total = slots.reduce((s, p) => s + p.probabilityWeight, 0);
  let roll = random(total);
  for (const p of slots) {
    if (roll < p.probabilityWeight) return p;
    roll -= p.probabilityWeight;
  }
  throw new RangeError(`roll past the total weight ${total}`);
}

export type SpinActor = { userId: string; tenantId: string };
export type SpinInput = { requestId: string; source: FingerprintSource | null; grantId?: string };

export type SpinResult = {
  attemptId: string;
  status: SpinAttemptStatus;
  refusalReason: SpinRefusalReason | null;
  version: number;
  tenantDay: string;
  seq: number | null;
  /** The slot the client animates to; null for a refused spin. */
  position: number | null;
  prize: { position: number; label: string; prizeType: SpinPrizeType; prizeValue: string } | null;
  reward: { grantId: string | null; coupon: RewardIssued['coupon'] } | null;
  replay: boolean;
};

export type WheelView = {
  tenantDay: string;
  version: number;
  currencyCode: string;
  /** Public odds (ADR-0111 point 4): each slot's weight over the total, as a percent to two places. */
  prizes: Array<{ position: number; label: string; prizeType: SpinPrizeType; prizeValue: string; oddsPercent: string }>;
  eligible: boolean;
  refusalReason: SpinRefusalReason | null;
  spinsLeftToday: number;
  nextSpinAt: string | null;
};

/** One of the caller's own attempts, as their history lists it (F-707-g). The checks stay server-side. */
export type WheelHistoryRow = {
  attemptId: string;
  at: string;
  tenantDay: string;
  status: SpinAttemptStatus;
  refusalReason: SpinRefusalReason | null;
  prize: { label: string; prizeType: SpinPrizeType; prizeValue: string } | null;
  /** A won coupon, named again so it can still be used. */
  coupon: { code: string; expiresAt: string | null } | null;
};

/** How far back the history goes: the newest attempts, never a page through every day. */
export const WHEEL_HISTORY_LIMIT = 30;

export type WheelInviteCheck = { wheel: false } | { wheel: true; eligible: boolean; refusalReason: SpinRefusalReason | null; spinsLeftToday: number };

export const WHEEL_SPIN_CLOCK = Symbol('WHEEL_SPIN_CLOCK');
export const WHEEL_SPIN_RANDOM = Symbol('WHEEL_SPIN_RANDOM');

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

function prizeOf(p: SpinPrize): SpinResult['prize'] {
  return { position: p.position, label: p.label, prizeType: p.prizeType, prizeValue: D(p.prizeValue).toFixed(2) };
}

/** Where a pick that became nothing lands: the first empty slot, if the wheel has one. */
function landingOf(cfg: SpinConfig, given: SpinPrize | null, picked: SpinPrize): number | null {
  if (given) return given.position;
  if (picked.prizeType === SpinPrizeType.empty) return picked.position;
  return [...cfg.prizes].sort((a, b) => a.position - b.position).find((p) => p.prizeType === SpinPrizeType.empty)?.position ?? null;
}

@Injectable()
export class WheelSpinService {
  private readonly logger = new Logger(WheelSpinService.name);
  private readonly now: () => Date;
  private readonly random: (below: number) => number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: GrantService,
    @Optional() @Inject(WHEEL_SPIN_CLOCK) now?: () => Date,
    @Optional() @Inject(WHEEL_SPIN_RANDOM) random?: (below: number) => number,
  ) {
    this.now = now ?? (() => new Date());
    this.random = random ?? ((below) => randomInt(below));
  }

  /** The wheel as a user sees it: the odds, and whether they may spin now and why not. Writes nothing. */
  view(actor: SpinActor, source: FingerprintSource | null): Promise<WheelView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const at = this.now();
      const day = tenantDayOf(at, await tenantZoneOf(tx, actor.tenantId));
      const cfg = await this.versionOn(tx, actor.tenantId, day);
      if (!cfg) throw new WheelSpinRefused('no_wheel');
      const accounts = source ? await accountsOnFingerprint(tx, { tenantId: actor.tenantId, fingerprintHash: fingerprintHash(source), at }) : 0;
      const facts = await this.facts(tx, actor, cfg, day, Math.max(accounts, 1));
      const { refusal } = checkEligibility(cfg, facts, at);
      const total = cfg.prizes.reduce((s, p) => s + p.probabilityWeight, 0);
      const nextAt = facts.lastAwardedAt ? new Date(facts.lastAwardedAt.getTime() + cfg.perUserCooldownHours * HOUR_MS) : null;
      return {
        tenantDay: isoDay(day),
        version: cfg.version,
        currencyCode: cfg.currencyCode,
        prizes: [...cfg.prizes]
          .sort((a, b) => a.position - b.position)
          .map((p) => ({ ...(prizeOf(p) as NonNullable<SpinResult['prize']>), oddsPercent: D(p.probabilityWeight).mul(100).div(total).toFixed(2) })),
        eligible: refusal === null,
        refusalReason: refusal?.reason ?? null,
        spinsLeftToday: Math.max(0, cfg.maxSpinsPerAccountPerDay - facts.awardedToday),
        nextSpinAt: nextAt && nextAt.getTime() > at.getTime() ? nextAt.toISOString() : null,
      };
    });
  }

  /**
   * F-038-u: may this user spin now — what an AI `wheel_invite` asks when
   * worker-service delivers it, in the tenant it names. The user's own view
   * with no device: the device is checked at the spin (ADR-0111 point 3).
   * `{ wheel: false }` when none is in force today. Writes nothing.
   */
  async inviteCheck(actor: SpinActor): Promise<WheelInviteCheck> {
    try {
      const view = await runWithTenant({ id: actor.tenantId }, () => this.view(actor, null));
      return { wheel: true, eligible: view.eligible, refusalReason: view.refusalReason, spinsLeftToday: view.spinsLeftToday };
    } catch (e) {
      if (e instanceof WheelSpinRefused && e.reason === 'no_wheel') return { wheel: false };
      throw e;
    }
  }

  /** The caller's own attempts, newest first, at most {@link WHEEL_HISTORY_LIMIT}. Writes nothing. */
  history(actor: SpinActor): Promise<WheelHistoryRow[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.spinWheelAttempt.findMany({
        where: { tenantId: actor.tenantId, userId: actor.userId },
        orderBy: { attemptedAt: 'desc' },
        take: WHEEL_HISTORY_LIMIT,
        select: { id: true, attemptedAt: true, tenantDay: true, status: true, refusalReason: true, prizeAwarded: { select: { label: true, prizeType: true, prizeValue: true } } },
      });
      const won = rows.filter((r) => r.prizeAwarded?.prizeType === SpinPrizeType.discount_coupon).map((r) => r.id);
      const issued = won.length ? await tx.rewardIssue.findMany({ where: { source: RewardSource.spin, referenceId: { in: won } }, select: { referenceId: true, couponId: true } }) : [];
      const couponIds = issued.map((i) => i.couponId).filter((id): id is string => id !== null);
      const coupons = couponIds.length ? await tx.coupon.findMany({ where: { id: { in: couponIds } }, select: { id: true, code: true, expiresAt: true } }) : [];
      const couponOf = (attemptId: string) => {
        const c = coupons.find((x) => x.id === issued.find((i) => i.referenceId === attemptId)?.couponId);
        return c ? { code: c.code, expiresAt: c.expiresAt?.toISOString() ?? null } : null;
      };
      return rows.map((r) => ({
        attemptId: r.id,
        at: r.attemptedAt.toISOString(),
        tenantDay: isoDay(r.tenantDay),
        status: r.status,
        refusalReason: r.refusalReason as SpinRefusalReason | null,
        prize: r.prizeAwarded ? { label: r.prizeAwarded.label, prizeType: r.prizeAwarded.prizeType, prizeValue: D(r.prizeAwarded.prizeValue).toFixed(2) } : null,
        coupon: couponOf(r.id),
      }));
    });
  }

  async spin(actor: SpinActor, input: SpinInput): Promise<SpinResult> {
    try {
      return await tenantTransaction(this.prisma, (tx) => this.spinIn(tx, actor, input));
    } catch (e) {
      // The same request twice at once: the idempotency unique lets one through.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new WheelSpinRefused('spin_in_progress');
      throw e;
    }
  }

  private async spinIn(tx: Tx, actor: SpinActor, input: SpinInput): Promise<SpinResult> {
    const prior = await tx.spinWheelAttempt.findUnique({
      where: { tenantId_userId_idempotencyKey: { tenantId: actor.tenantId, userId: actor.userId, idempotencyKey: input.requestId } },
    });
    if (prior) return this.replayOf(tx, actor, prior);

    const at = this.now();
    const day = tenantDayOf(at, await tenantZoneOf(tx, actor.tenantId));
    const cfg = await this.versionOn(tx, actor.tenantId, day);
    if (!cfg) throw new WheelSpinRefused('no_wheel');
    if (!input.source) throw new WheelSpinRefused('no_fingerprint');

    const fp = await recordFingerprint(tx, { tenantId: actor.tenantId, userId: actor.userId, source: input.source, at });
    const accounts = await accountsOnFingerprint(tx, { tenantId: actor.tenantId, fingerprintHash: fp.fingerprintHash, at });

    // Every spin of the tenant's day queues here; the user's count is read after.
    const dayKey = isoDay(day);
    await tx.$executeRaw`INSERT INTO engagement.spin_wheel_day ("tenantId", "tenantDay", "wheelConfigId", "currencyCode")
      VALUES (${actor.tenantId}::uuid, ${dayKey}::date, ${cfg.id}::uuid, ${cfg.currencyCode}) ON CONFLICT ("tenantId", "tenantDay") DO NOTHING`;
    const [dayRow] = await tx.$queryRaw<Array<{ costSpent: Prisma.Decimal; spins: number; capAlertedAt: Date | null }>>`SELECT "costSpent", spins, "capAlertedAt" FROM engagement.spin_wheel_day
      WHERE "tenantId" = ${actor.tenantId}::uuid AND "tenantDay" = ${dayKey}::date FOR UPDATE`;

    const facts = await this.facts(tx, actor, cfg, day, accounts);
    const { checks, refusal } = checkEligibility(cfg, facts, at);
    const id = randomUUID();
    const snapshot = { at: at.toISOString(), version: cfg.version, tenantDay: dayKey, checks } as Prisma.InputJsonValue;
    const base = {
      id,
      tenantId: actor.tenantId,
      wheelConfigId: cfg.id,
      userId: actor.userId,
      deviceFingerprintId: fp.id,
      tenantDay: day,
      idempotencyKey: input.requestId,
      attemptedAt: at,
      eligibilityCheckSnapshotJson: snapshot,
      currencyCode: cfg.currencyCode,
    };

    if (refusal) {
      await tx.spinWheelAttempt.create({ data: { ...base, status: refusal.status, refusalReason: refusal.reason, seq: null, costAmount: '0.00' } });
      return { attemptId: id, status: refusal.status, refusalReason: refusal.reason, version: cfg.version, tenantDay: dayKey, seq: null, position: null, prize: null, reward: null, replay: false };
    }

    const picked = pickSlot(cfg.prizes, this.random);
    const seq = facts.awardedToday + 1;
    let given: SpinPrize | null = null;
    let reward: RewardIssued | null = null;
    if (picked.prizeType !== SpinPrizeType.empty && D(dayRow.costSpent).add(picked.costAmount).lte(cfg.dailyBudgetCapAmount) && (await this.inStock(tx, actor.tenantId, picked, dayKey))) {
      reward = await this.issue(tx, actor, cfg, picked, id, at, input.grantId);
      given = reward ? picked : null;
    }
    const cost = given ? D(given.costAmount) : D(0);

    await tx.spinWheelDay.update({
      where: { tenantId_tenantDay: { tenantId: actor.tenantId, tenantDay: day } },
      data: { costSpent: { increment: cost.toFixed(2) }, spins: { increment: 1 } },
    });
    if (given && given.dailyStockLimit !== null) {
      await tx.spinWheelPrizeDay.update({ where: { prizeId_tenantDay: { prizeId: given.id, tenantDay: day } }, data: { awardedCount: { increment: 1 } } });
    }
    if (given) {
      const spent = D(dayRow.costSpent).add(cost);
      await alertCapCrossing(tx, { tenantId: actor.tenantId, tenantDay: day, spent, cap: D(cfg.dailyBudgetCapAmount), currencyCode: cfg.currencyCode, alertedAt: dayRow.capAlertedAt ?? null, at });
    }
    await tx.spinWheelAttempt.create({
      data: { ...base, status: SpinAttemptStatus.awarded, seq, pickedPrizeId: picked.id, prizeAwardedId: given?.id ?? null, costAmount: cost.toFixed(2) },
    });
    this.logger.log(`spin ${id}: v${cfg.version} picked ${picked.position}, given ${given?.position ?? 'nothing'}`);
    return {
      attemptId: id,
      status: SpinAttemptStatus.awarded,
      refusalReason: null,
      version: cfg.version,
      tenantDay: dayKey,
      seq,
      position: landingOf(cfg, given, picked),
      prize: given ? prizeOf(given) : null,
      reward: reward ? { grantId: reward.grantId, coupon: reward.coupon } : null,
      replay: false,
    };
  }

  /** Under its own day row's lock: a prize with a stock has one left today. */
  private async inStock(tx: Tx, tenantId: string, prize: SpinPrize, dayKey: string): Promise<boolean> {
    if (prize.dailyStockLimit === null) return true;
    await tx.$executeRaw`INSERT INTO engagement.spin_wheel_prize_day ("prizeId", "tenantDay", "tenantId")
      VALUES (${prize.id}::uuid, ${dayKey}::date, ${tenantId}::uuid) ON CONFLICT ("prizeId", "tenantDay") DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ awardedCount: number }>>`SELECT "awardedCount" FROM engagement.spin_wheel_prize_day
      WHERE "prizeId" = ${prize.id}::uuid AND "tenantDay" = ${dayKey}::date FOR UPDATE`;
    return row.awardedCount < prize.dailyStockLimit;
  }

  /** The prize, inside a savepoint: a refusal undoes whatever the issuer wrote, and the spin goes on as nothing. */
  private async issue(tx: Tx, actor: SpinActor, cfg: SpinConfig, prize: SpinPrize, attemptId: string, at: Date, grantId?: string): Promise<RewardIssued | null> {
    await tx.$executeRaw`SAVEPOINT spin_reward`;
    try {
      const issued = await issueReward(tx, this.grants, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        source: RewardSource.spin,
        referenceId: attemptId,
        prize,
        actorUserId: cfg.createdByAdminId,
        at,
        grantId,
      });
      await tx.$executeRaw`RELEASE SAVEPOINT spin_reward`;
      return issued;
    } catch (e) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT spin_reward`;
      if (e instanceof RewardRefused || (e instanceof Error && e.name === 'EntitlementRefused')) {
        this.logger.warn(`spin ${attemptId}: prize ${prize.position} not given (${e.message})`);
        return null;
      }
      throw e;
    }
  }

  private async versionOn(tx: Tx, tenantId: string, day: Date): Promise<SpinConfig | null> {
    const cfg = (await tx.spinWheelConfig.findFirst({
      where: { tenantId, effectiveFromDay: { lte: day } },
      orderBy: { version: 'desc' },
      include: { prizes: true },
    })) as SpinConfig | null;
    return cfg && cfg.isActive ? cfg : null;
  }

  private async facts(tx: Tx, actor: SpinActor, cfg: SpinConfig, day: Date, accounts: number): Promise<EligibilityFacts> {
    const user = await tx.user.findUnique({ where: { id: actor.userId }, select: { status: true, deletedAt: true, createdAt: true, phoneVerifiedAt: true } });
    if (!user) throw new Error(`user ${actor.userId} not found spinning the wheel`);
    const [activeGrants, paid, openFraudFlags, member, awarded] = await Promise.all([
      tx.grant.count({ where: { userId: actor.userId, status: GrantStatus.active } }),
      tx.invoice.aggregate({ where: { userId: actor.userId, status: InvoiceStatus.paid, currencyCode: cfg.currencyCode }, _sum: { total: true }, _count: { _all: true } }),
      tx.fraudFlag.count({ where: { subjectType: FraudSubjectType.user, subjectId: actor.userId, resolvedAt: null } }),
      cfg.userGroupId ? tx.userGroupMember.findFirst({ where: { ...liveMembership(), groupId: cfg.userGroupId, userId: actor.userId }, select: { id: true } }) : Promise.resolve(undefined),
      tx.spinWheelAttempt.findMany({
        where: { tenantId: actor.tenantId, userId: actor.userId, tenantDay: day, status: SpinAttemptStatus.awarded },
        select: { attemptedAt: true },
        orderBy: { attemptedAt: 'desc' },
      }),
    ]);
    return {
      userActive: user.status === UserStatus.active && user.deletedAt === null,
      accountCreatedAt: user.createdAt,
      phoneVerified: user.phoneVerifiedAt !== null,
      activeGrants,
      totalPaid: D(paid._sum.total ?? 0),
      paidOrders: paid._count._all,
      openFraudFlags,
      accountsOnFingerprint: accounts,
      inGroup: cfg.userGroupId ? member !== null : null,
      awardedToday: awarded.length,
      lastAwardedAt: (awarded[0]?.attemptedAt as Date | undefined) ?? null,
    };
  }

  /** A retried request: what it got the first time. The issuer's own replay names the coupon again. */
  private async replayOf(
    tx: Tx,
    actor: SpinActor,
    a: { id: string; wheelConfigId: string; status: SpinAttemptStatus; refusalReason: string | null; tenantDay: Date; seq: number | null; pickedPrizeId: string | null; prizeAwardedId: string | null; attemptedAt: Date },
  ): Promise<SpinResult> {
    const cfg = (await tx.spinWheelConfig.findFirst({ where: { id: a.wheelConfigId }, include: { prizes: true } })) as SpinConfig;
    const given = cfg.prizes.find((p) => p.id === a.prizeAwardedId) ?? null;
    const picked = cfg.prizes.find((p) => p.id === a.pickedPrizeId) ?? null;
    const reward = given
      ? await issueReward(tx, this.grants, { tenantId: actor.tenantId, userId: actor.userId, source: RewardSource.spin, referenceId: a.id, prize: given, actorUserId: cfg.createdByAdminId, at: a.attemptedAt })
      : null;
    return {
      attemptId: a.id,
      status: a.status,
      refusalReason: a.refusalReason as SpinRefusalReason | null,
      version: cfg.version,
      tenantDay: isoDay(a.tenantDay),
      seq: a.seq,
      position: picked ? landingOf(cfg, given, picked) : null,
      prize: given ? prizeOf(given) : null,
      reward: reward ? { grantId: reward.grantId, coupon: reward.coupon } : null,
      replay: true,
    };
  }
}
