import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  GrantStatus,
  Prisma,
  RateCardAfterIncluded,
  RateCardMode,
  UsageAuthorization,
  UsageAuthorizationStatus,
  WalletReasonType,
} from '@prisma/client';
import { DOOR_METERS, recordUsage, runWithTenant, TenantBillingLedger, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletHoldService, WalletLedgerService } from '../wallet/wallet-ledger.service';
import { spendOnCap, withinCap } from './cap-funding';
import { PostpaidHolds, type Ctx, type MeterRef } from './postpaid-hold';
import { blockFor, max, min, moveCursors, toAmount, toCents, unitsCovered, UsageSettlementRefused, ZERO, type UsageSettlementRefusal } from './usage-price';
import { UsageRefundService } from './usage-refund';
import { priceOf, WholesaleCursorMoved, WholesaleLeg, WholesaleUnfunded } from './usage-wholesale';

/**
 * The per-use door (F-118-h, ADR-0105 decision 7): the enforcer of every
 * meter in `DOOR_METERS` — `vpn.config.regenerate` first. Work on one is
 * authorized **before** it is done, and refused, with nothing written, when
 * its money is not there.
 *
 * - `authorize(grant, meter, quantity, key)` makes `quantity` more units
 *   funded — on a reseller's Grant, first bought on the reseller's billing
 *   wallet at the locked wholesale rate (`metered_usage_charge`, prepaid
 *   whatever the user's mode, §14.5), then a prepaid block debited
 *   (`usage_charge`) or the meter's hold grown (postpaid) — and answers a
 *   token. Every refusal is decided before the first write.
 * - `commit(token, actual)` records the actual use as a `usage_event` keyed by
 *   the token; postpaid captures it from the hold.
 * - `cancel(token)` records nothing. Its expiry does the same, at the next
 *   authorization on the meter or the hourly sweep (`expireDue`).
 *
 * Each settlement then **gives back what no open token still needs**: a
 * prepaid surplus as `usage_refund`, a postpaid hold down to what is still
 * reserved, the reseller's surplus as `metered_usage_refund` — all priced
 * down, so a give-back never exceeds what was paid. An open token reserves its
 * `quantity`: two at once are each funded.
 *
 * The included quantity is free to the user; the reseller's wholesale leg has
 * no included part — the package rate prices every unit (F-118-n1).
 *
 * In the caller's `tx`, from `tenantTransaction`. The meter's own hold
 * (`ownerRef` = the `grant_meter` id) is the only one a door meter has, so
 * the spending cap counts it (F-118-i).
 */

/** Why the door wrote nothing. The engine's own refusals pass through with their names. */
export type UsageDoorRefusal =
  | UsageSettlementRefusal
  /** Not a `DOOR_METERS` meter: nothing here refuses its unfunded use. */
  | 'meter_not_on_door'
  | 'quantity_not_positive'
  /** The reseller's billing wallet cannot buy the wholesale units (§14.5: at zero, its users stop). */
  | 'wholesale_unfunded'
  /** The key was already used for another quantity. */
  | 'key_reused'
  | 'token_not_found'
  /** Committed, cancelled or expired already. */
  | 'token_settled'
  | 'token_expired'
  | 'over_authorized';

export class UsageDoorRefused extends Error {
  constructor(
    readonly reason: UsageDoorRefusal,
    detail = '',
  ) {
    super(`usage door refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'UsageDoorRefused';
  }
}

export type Authorization = { token: string; quantity: bigint; status: UsageAuthorizationStatus; expiresAt: Date };
export type ExpireDueResult = { expired: number; errors: number };

/** How long a token holds its units unless the caller says otherwise. */
export const AUTHORIZATION_TTL_MS = 10 * 60_000;
/** `usage_event.source` of a committed token; the token's id is its key. */
export const DOOR_SOURCE = 'billing.usage-door';
const EXPIRE_BATCH = 500;

type Plan = { units: bigint; cents: bigint };

const view = (t: UsageAuthorization): Authorization => ({ token: t.id, quantity: t.quantity, status: t.status, expiresAt: t.expiresAt });

@Injectable()
export class UsageDoorService {
  private readonly logger = new Logger(UsageDoorService.name);
  private readonly postpaid: PostpaidHolds;
  private readonly wholesale: WholesaleLeg;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly ledger: WalletLedgerService,
    private readonly holds: WalletHoldService,
    private readonly refunds: UsageRefundService,
    tenantLedger: TenantBillingLedger,
  ) {
    this.postpaid = new PostpaidHolds(holds);
    this.wholesale = new WholesaleLeg(tenantLedger);
  }

  async authorize(
    tx: Prisma.TransactionClient,
    input: MeterRef & { quantity: bigint; key: string; ttlMs?: number },
    now: Date = new Date(),
  ): Promise<Authorization> {
    return this.named(async () => {
      if (input.quantity <= ZERO) throw new UsageDoorRefused('quantity_not_positive', input.quantity.toString());
      if (!DOOR_METERS.has(input.meterKey)) throw new UsageDoorRefused('meter_not_on_door', input.meterKey);
      const ref = { grantId: input.grantId, meterKey: input.meterKey };
      const same = await tx.usageAuthorization.findUnique({ where: { grantId_meterKey_idempotencyKey: { ...ref, idempotencyKey: input.key } } });
      if (same) {
        if (same.quantity !== input.quantity) throw new UsageDoorRefused('key_reused', input.key);
        return view(same);
      }
      await this.expireOn(tx, ref, now);

      const ctx = await this.load(tx, ref);
      const { grant, meter } = ctx;
      if (grant.status !== GrantStatus.active) throw new UsageDoorRefused('grant_not_active', grant.status);
      const need = meter.consumed + (await this.reserved(tx, ref)) + input.quantity;

      // Every refusal before the first write: a refused authorization leaves nothing behind.
      const wholesale = await this.wholesale.plan(tx, meter, need);
      const retail = await this.retailPlan(tx, ctx, need);

      const id = randomUUID();
      const token = await tx.usageAuthorization.create({
        data: {
          id,
          tenantId: meter.tenantId,
          ...ref,
          idempotencyKey: input.key,
          quantity: input.quantity,
          boughtUnits: retail?.kind === 'block' ? retail.units : ZERO,
          heldAmount: retail?.kind === 'hold' ? toAmount(retail.cents) : new Prisma.Decimal(0),
          wholesaleUnits: wholesale?.units ?? ZERO,
          expiresAt: new Date(now.getTime() + (input.ttlMs ?? AUTHORIZATION_TTL_MS)),
        },
      });

      if (wholesale) await this.wholesale.buy(tx, meter, wholesale, id);
      if (retail?.kind === 'block') {
        const bought = max(meter.funded, meter.includedQuantity) + retail.units;
        await moveCursors(tx, meter, { funded: bought, billed: bought });
        const amount = toAmount(retail.cents);
        await this.ledger.debit(tx, { userId: grant.userId, amount, currencyCode: meter.currencyCode, reasonType: WalletReasonType.usage_charge, referenceId: grant.id });
        await spendOnCap(tx, grant.id, amount);
      } else if (retail?.kind === 'hold') {
        await this.holds.hold(tx, { userId: grant.userId, ownerRef: meter.id, amount: toAmount(retail.cents), currencyCode: meter.currencyCode });
        await moveCursors(tx, meter, { funded: retail.funded });
      }
      return view(token);
    });
  }

  /** Records `quantity` (0..authorized) as used, then gives back what no open token needs. A repeat of the same commit is answered, not re-applied. */
  async commit(tx: Prisma.TransactionClient, input: { token: string; quantity: bigint }, now: Date = new Date()): Promise<Authorization> {
    return this.named(async () => {
      const token = await this.token(tx, input.token);
      if (token.status === UsageAuthorizationStatus.committed && token.committedQuantity === input.quantity) return view(token);
      if (token.status !== UsageAuthorizationStatus.open) throw new UsageDoorRefused('token_settled', token.status);
      if (token.expiresAt.getTime() <= now.getTime()) throw new UsageDoorRefused('token_expired', token.id);
      if (input.quantity < ZERO) throw new UsageDoorRefused('quantity_not_positive', input.quantity.toString());
      if (input.quantity > token.quantity) throw new UsageDoorRefused('over_authorized', `${input.quantity} > ${token.quantity}`);

      const settled = await this.settle(tx, token, UsageAuthorizationStatus.committed, now, input.quantity);
      if (input.quantity > ZERO) {
        await recordUsage(tx, { grantId: token.grantId, meterKey: token.meterKey, quantity: input.quantity, occurredAt: now, source: DOOR_SOURCE, idempotencyKey: token.id });
      }
      await this.giveBack(tx, token, true);
      return view(settled);
    });
  }

  /** The work was not done: nothing is recorded and its money is given back. Cancelling a settled-unused token again is answered. */
  async cancel(tx: Prisma.TransactionClient, input: { token: string }, now: Date = new Date()): Promise<Authorization> {
    return this.named(async () => {
      const token = await this.token(tx, input.token);
      if (token.status === UsageAuthorizationStatus.cancelled || token.status === UsageAuthorizationStatus.expired) return view(token);
      if (token.status !== UsageAuthorizationStatus.open) throw new UsageDoorRefused('token_settled', token.status);
      const settled = await this.settle(tx, token, UsageAuthorizationStatus.cancelled, now);
      await this.giveBack(tx, token, false);
      return view(settled);
    });
  }

  /**
   * The hourly sweep's half (`usage-internal.controller.ts`): every open token
   * past its `expiresAt`, expired in its tenant's transaction, one each.
   * Safe to run twice: an expired token is no longer open.
   */
  async expireDue(now: Date = new Date()): Promise<ExpireDueResult> {
    const due = await this.crossTenant.usageAuthorization.findMany({
      where: { status: UsageAuthorizationStatus.open, expiresAt: { lte: now } },
      select: { id: true, tenantId: true },
      orderBy: { expiresAt: 'asc' },
      take: EXPIRE_BATCH,
    });
    let expired = 0;
    let errors = 0;
    for (const t of due) {
      try {
        await runWithTenant({ id: t.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.expire(tx, t.id, now)));
        expired += 1;
      } catch (e) {
        errors += 1;
        this.logger.error(`expiry of usage_authorization ${t.id} failed: ${(e as Error).message}`);
      }
    }
    return { expired, errors };
  }

  /** The user's side for `need`: nothing when the meter already funds it, else a whole block or a whole hold. */
  private async retailPlan(
    tx: Prisma.TransactionClient,
    { grant, meter }: Ctx,
    need: bigint,
  ): Promise<(Plan & { kind: 'block' }) | { kind: 'hold'; cents: bigint; funded: bigint } | null> {
    if (need <= meter.includedQuantity) return null;
    if (meter.afterIncluded === RateCardAfterIncluded.stop) throw new UsageDoorRefused('not_metered_past_included', meter.meterKey);
    const room = await withinCap(tx, grant, await this.postpaid.freeBalance(tx, grant.userId));

    if (meter.mode === RateCardMode.prepaid) {
      const short = need - max(meter.funded, meter.includedQuantity);
      if (short <= ZERO) return null;
      if (priceOf(meter, short) > toCents(room)) throw new UsageDoorRefused('insufficient_funds', room.toString());
      return { kind: 'block', ...blockFor(meter, short, room) };
    }
    const from = max(meter.billed, meter.includedQuantity);
    const held = await this.postpaid.heldCents(tx, { grant, meter });
    if (need <= from + unitsCovered(meter, held)) return null;
    const target = priceOf(meter, need - from);
    const add = target - held;
    if (add > toCents(room)) throw new UsageDoorRefused('insufficient_funds', room.toString());
    return { kind: 'hold', cents: add, funded: from + unitsCovered(meter, target) };
  }

  /**
   * After a token settles: postpaid captures what was used; then the user's
   * side and the reseller's are brought down to what is used plus what open
   * tokens still reserve, priced down.
   */
  private async giveBack(tx: Prisma.TransactionClient, token: UsageAuthorization, used: boolean): Promise<void> {
    const ctx = await this.load(tx, token);
    const reserved = await this.reserved(tx, token);
    const { meter } = ctx;

    if (meter.afterIncluded === RateCardAfterIncluded.metered) {
      const usedTo = max(meter.consumed + reserved, meter.includedQuantity);
      if (meter.mode === RateCardMode.prepaid) {
        await this.refunds.giveBackAbove(tx, ctx, usedTo);
      } else {
        if (used) await this.postpaid.capture(tx, ctx);
        await this.refitHold(tx, ctx, usedTo);
      }
    }

    await this.wholesale.giveBack(tx, meter, meter.consumed + reserved, token.id);
  }

  /** The meter's hold down to the price of what is still due or reserved past `billed`; `funded` to what it then covers. */
  private async refitHold(tx: Prisma.TransactionClient, ctx: Ctx, usedTo: bigint): Promise<void> {
    const { grant, meter } = ctx;
    const from = max(meter.billed, meter.includedQuantity);
    const target = usedTo > from ? priceOf(meter, usedTo - from) : ZERO;
    const hold = await this.postpaid.openHold(tx, ctx);
    const held = hold ? toCents(hold.amount) : ZERO;
    // Nothing left to reserve closes the hold, even one a capture emptied.
    if (hold && target === ZERO) await this.holds.release(tx, { userId: grant.userId, ownerRef: meter.id });
    else if (held > target) await this.holds.release(tx, { userId: grant.userId, ownerRef: meter.id, amount: toAmount(held - target) });
    const funded = from + unitsCovered(meter, min(held, target));
    if (funded !== meter.funded) await moveCursors(tx, meter, { funded });
  }

  /** Every open token of this meter past its time, expired before a new one is counted. */
  private async expireOn(tx: Prisma.TransactionClient, ref: MeterRef, now: Date): Promise<void> {
    const due = await tx.usageAuthorization.findMany({ where: { ...ref, status: UsageAuthorizationStatus.open, expiresAt: { lte: now } } });
    for (const t of due) await this.expire(tx, t.id, now);
  }

  private async expire(tx: Prisma.TransactionClient, id: string, now: Date): Promise<void> {
    const token = await this.token(tx, id);
    if (token.status !== UsageAuthorizationStatus.open) return;
    await this.settle(tx, token, UsageAuthorizationStatus.expired, now);
    await this.giveBack(tx, token, false);
  }

  /** Units open tokens of this meter reserve. */
  private async reserved(tx: Prisma.TransactionClient, ref: MeterRef): Promise<bigint> {
    const open = await tx.usageAuthorization.findMany({
      where: { grantId: ref.grantId, meterKey: ref.meterKey, status: UsageAuthorizationStatus.open },
      select: { quantity: true },
    });
    return open.reduce((sum, t) => sum + t.quantity, ZERO);
  }

  /** Out of `open`, guarded on it: of two settlements racing, the second is `token_settled`. */
  private async settle(tx: Prisma.TransactionClient, token: UsageAuthorization, status: UsageAuthorizationStatus, now: Date, committedQuantity?: bigint): Promise<UsageAuthorization> {
    const data = { status, settledAt: now, committedQuantity: committedQuantity ?? null };
    const { count } = await tx.usageAuthorization.updateMany({ where: { id: token.id, status: UsageAuthorizationStatus.open }, data });
    if (count !== 1) throw new UsageDoorRefused('token_settled', token.id);
    return { ...token, ...data };
  }

  private async token(tx: Prisma.TransactionClient, id: string): Promise<UsageAuthorization> {
    const token = await tx.usageAuthorization.findUnique({ where: { id } });
    if (!token) throw new UsageDoorRefused('token_not_found', id);
    return token;
  }

  private async load(tx: Prisma.TransactionClient, ref: MeterRef): Promise<Ctx> {
    const grant = await tx.grant.findUnique({ where: { id: ref.grantId }, select: { id: true, userId: true, status: true } });
    if (!grant) throw new UsageDoorRefused('grant_not_found', ref.grantId);
    const meter = await tx.grantMeter.findUnique({ where: { grantId_meterKey: { grantId: ref.grantId, meterKey: ref.meterKey } } });
    if (!meter) throw new UsageDoorRefused('meter_not_on_grant', ref.meterKey);
    return { grant, meter };
  }

  /** The engine's refusals under the door's name, so a caller catches one type. */
  private async named<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UsageSettlementRefused) throw new UsageDoorRefused(e.reason, e.message);
      if (e instanceof WholesaleUnfunded) throw new UsageDoorRefused('wholesale_unfunded', e.message);
      if (e instanceof WholesaleCursorMoved) throw new UsageDoorRefused('cursor_moved', e.meterId);
      throw e;
    }
  }
}
