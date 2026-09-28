import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, RateSource, TenantType } from '@prisma/client';
import { UnscopedRedisKeys, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** `currency_exchange_rate.rate` is `DECIMAL(18, 8)`; a pin is rounded once, to it. */
const RATE_SCALE = 8;

export interface PinActor {
  userId: string;
  tenantId: string;
  ip: string;
}

export interface PinInput {
  code: string;
  /** Units of the currency per one USD, as a decimal string (C-02). */
  rate: string;
  reason: string;
  /** How long the pin applies, from now. */
  hours: number;
}

export interface PinView {
  id: string;
  code: string;
  rate: string;
  reason: string;
  setById: string;
  effectiveAt: string;
  expiresAt: string;
  endedAt: string | null;
}

/** What the manual-rate form shows for one currency (ADR-0101 part 4). */
export interface PinForm {
  code: string;
  current: PinView | null;
  /** The last rate the worker accepted — never a pin. */
  lastAccepted: { snapshotId: string; rate: string; effectiveAt: string } | null;
  /** The worker's latest reading, accepted or not: a suggestion, never a rate. */
  lastDownload: {
    rate: string | null;
    at: string;
    outcome: 'accepted' | 'refused' | 'unavailable';
    used: number;
    sources: number;
    reason: string | null;
  } | null;
}

export type CurrencyPinRejection =
  | 'not_platform_owner'
  | 'currency_not_found'
  | 'base_currency'
  | 'invalid_rate'
  | 'pin_not_found'
  | 'pin_over';

export class CurrencyPinRefused extends Error {
  constructor(
    readonly reason: CurrencyPinRejection,
    detail = '',
  ) {
    super(`currency pin refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'CurrencyPinRefused';
  }
}

type PinRow = {
  id: string;
  source: RateSource;
  rate: Prisma.Decimal;
  reason: string | null;
  setByAdminId: string | null;
  effectiveAt: Date;
  expiresAt: Date | null;
  currency: { code: string };
  pinEnd: { endedAt: Date } | null;
};

/**
 * F-0608-a (ADR-0101) — the platform's manual rate. A pin is a
 * `currency_exchange_rate` row with `source = manual_admin`, a reason and an
 * expiry; while it is live, shared-core `readFxRate` answers it before any
 * discovered rate, so every service prices at it with no change of its own.
 * Ending one early writes a `currency_rate_pin_end` row and edits nothing
 * (invariant #3). Both writes carry their `admin_audit_log` row in the same
 * transaction. A tenant's pin, inside its own books only, is F-116-j.
 */
@Injectable()
export class CurrencyPinService {
  private readonly logger = new Logger(CurrencyPinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async view(actor: PinActor, code: string): Promise<PinForm> {
    await this.access(actor);
    const currency = await this.pinnable(code);

    const [pin, accepted, reading] = await Promise.all([
      this.prisma.currencyExchangeRate.findFirst({
        where: {
          currencyId: currency.id,
          source: RateSource.manual_admin,
          expiresAt: { gt: new Date() },
          pinEnd: { is: null },
        },
        orderBy: { effectiveAt: 'desc' },
        include: { currency: { select: { code: true } }, pinEnd: { select: { endedAt: true } } },
      }),
      this.prisma.currencyExchangeRate.findFirst({
        where: { currencyId: currency.id, isActive: true, source: RateSource.external_api },
        orderBy: { effectiveAt: 'desc' },
        select: { id: true, rate: true, effectiveAt: true },
      }),
      this.lastDownload(code),
    ]);

    return {
      code,
      current: pin ? toView(pin as PinRow) : null,
      lastAccepted: accepted
        ? { snapshotId: accepted.id, rate: accepted.rate.toString(), effectiveAt: accepted.effectiveAt.toISOString() }
        : null,
      lastDownload: reading,
    };
  }

  async pin(actor: PinActor, input: PinInput): Promise<PinView> {
    await this.access(actor);
    const currency = await this.pinnable(input.code);

    let rate: Prisma.Decimal;
    try {
      rate = new Prisma.Decimal(input.rate).toDecimalPlaces(RATE_SCALE, Prisma.Decimal.ROUND_HALF_UP);
    } catch {
      throw new CurrencyPinRefused('invalid_rate', input.rate);
    }
    if (!rate.isFinite() || rate.lte(0)) throw new CurrencyPinRefused('invalid_rate', input.rate);

    const expiresAt = new Date(Date.now() + input.hours * 3_600_000);
    // `tenantTransaction`: the audit row is under RLS, and a bare
    // `$transaction` carries no tenant binding into its statements.
    const row = await tenantTransaction(this.prisma, async (tx) => {
      const created = await tx.currencyExchangeRate.create({
        data: {
          currencyId: currency.id,
          rate,
          source: RateSource.manual_admin,
          setByAdminId: actor.userId,
          reason: input.reason,
          expiresAt,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: actor.tenantId,
          adminId: actor.userId,
          action: AdminAction.currency_rate_pin,
          targetEntityType: AuditTargetType.currency_exchange_rate,
          targetEntityId: created.id,
          newValue: { code: input.code, rate: rate.toString(), expiresAt: expiresAt.toISOString() },
          reason: input.reason,
          adminIpAddress: actor.ip,
        },
      });
      return created;
    });

    this.logger.log(`${input.code} pinned at ${rate.toString()} until ${expiresAt.toISOString()} by ${actor.userId}`);
    return toView({ ...row, currency: { code: input.code }, pinEnd: null } as PinRow);
  }

  async end(actor: PinActor, pinId: string): Promise<PinView> {
    await this.access(actor);
    const pin = (await this.prisma.currencyExchangeRate.findUnique({
      where: { id: pinId },
      include: { currency: { select: { code: true } }, pinEnd: { select: { endedAt: true } } },
    })) as PinRow | null;

    if (!pin || pin.source !== RateSource.manual_admin) throw new CurrencyPinRefused('pin_not_found', pinId);
    if (pin.pinEnd || !pin.expiresAt || pin.expiresAt <= new Date()) throw new CurrencyPinRefused('pin_over', pinId);

    try {
      const ended = await tenantTransaction(this.prisma, async (tx) => {
        const end = await tx.currencyRatePinEnd.create({ data: { rateId: pin.id, endedById: actor.userId } });
        await tx.adminAuditLog.create({
          data: {
            tenantId: actor.tenantId,
            adminId: actor.userId,
            action: AdminAction.currency_rate_pin_end,
            targetEntityType: AuditTargetType.currency_exchange_rate,
            targetEntityId: pin.id,
            oldValue: { expiresAt: pin.expiresAt?.toISOString() ?? null },
            newValue: { endedAt: end.endedAt.toISOString() },
            adminIpAddress: actor.ip,
          },
        });
        return end;
      });
      this.logger.log(`${pin.currency.code} pin ${pin.id} ended by ${actor.userId}`);
      return toView({ ...pin, pinEnd: { endedAt: ended.endedAt } });
    } catch (e) {
      // Two admins ending the same pin: the unique `rateId` lets one through.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new CurrencyPinRefused('pin_over', pinId);
      }
      throw e;
    }
  }

  /** The platform owner's tenant, and nobody else's (a tenant's pin is F-116-j). */
  private async access(actor: PinActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new CurrencyPinRefused('not_platform_owner', actor.tenantId);
    }
  }

  /** An active, non-base currency: the base is 1 by definition and has no rate to pin. */
  private async pinnable(code: string): Promise<{ id: string }> {
    const currency = await this.prisma.currency.findUnique({
      where: { code },
      select: { id: true, isActive: true, isBaseCurrency: true },
    });
    if (!currency || !currency.isActive) throw new CurrencyPinRefused('currency_not_found', code);
    if (currency.isBaseCurrency) throw new CurrencyPinRefused('base_currency', code);
    return currency;
  }

  /** `fx:reading:{code}`, written by the worker. Unreadable is simply absent. */
  private async lastDownload(code: string): Promise<PinForm['lastDownload']> {
    try {
      const raw = await this.redis.get(UnscopedRedisKeys.fxReading(code));
      return raw ? (JSON.parse(raw) as PinForm['lastDownload']) : null;
    } catch (err) {
      this.logger.warn(`${code} last download unreadable: ${(err as Error).message}`);
      return null;
    }
  }
}

function toView(row: PinRow): PinView {
  return {
    id: row.id,
    code: row.currency.code,
    rate: row.rate.toString(),
    reason: row.reason ?? '',
    setById: row.setByAdminId ?? '',
    effectiveAt: row.effectiveAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? '',
    endedAt: row.pinEnd ? row.pinEnd.endedAt.toISOString() : null,
  };
}
