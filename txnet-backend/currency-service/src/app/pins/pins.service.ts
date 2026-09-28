import { Injectable, Logger } from '@nestjs/common';
import {
  AdminAction,
  AuditTargetType,
  Prisma,
  RateSource,
  TenantType,
} from '@prisma/client';
import {
  UnscopedRedisKeys,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { BillingClient } from '../billing/billing.client';
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
  /** The live pin this caller controls: the tenant's own, or the platform's. */
  current: PinView | null;
  /** For a tenant, the platform's live pin, which answers where it has none. Null for the platform. */
  platformPin: PinView | null;
  /** The last rate the worker accepted — never a pin. */
  lastAccepted: {
    snapshotId: string;
    rate: string;
    effectiveAt: string;
  } | null;
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
  | 'currency_not_yours'
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
  tenantId: string | null;
  currency: { code: string };
  pinEnd: { endedAt: Date } | null;
};

/**
 * Whose pins a caller writes (F-116-j): the platform's own (`tenantId` null,
 * priced everywhere a tenant has none), or one tenant's (inside its books
 * only, ADR-0098 part 9) — and for which currencies.
 */
type Scope =
  | { kind: 'platform'; tenantId: null }
  | { kind: 'tenant'; tenantId: string; operatingCurrencyCode: string };

/**
 * F-0608-a (ADR-0101) — the platform's manual rate, and since F-116-j a
 * tenant's for its own books. A pin is a
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
    private readonly billing: BillingClient,
  ) {}

  async view(actor: PinActor, code: string): Promise<PinForm> {
    const scope = await this.access(actor);
    const currency = await this.pinnable(code, scope);

    // Every read of a rate row in `tenantTransaction`: the table is under RLS
    // (F-116-j), and only a bound transaction shows the caller its own pins.
    return tenantTransaction(this.prisma, async (tx) => {
      const livePin = (tenantId: string | null) =>
        tx.currencyExchangeRate.findFirst({
          where: {
            currencyId: currency.id,
            source: RateSource.manual_admin,
            tenantId,
            expiresAt: { gt: new Date() },
            pinEnd: { is: null },
          },
          orderBy: { effectiveAt: 'desc' },
          include: {
            currency: { select: { code: true } },
            pinEnd: { select: { endedAt: true } },
          },
        });

      const [pin, platformPin, accepted, reading] = await Promise.all([
        livePin(scope.tenantId),
        scope.kind === 'tenant' ? livePin(null) : Promise.resolve(null),
        tx.currencyExchangeRate.findFirst({
          where: {
            currencyId: currency.id,
            isActive: true,
            source: RateSource.external_api,
          },
          orderBy: { effectiveAt: 'desc' },
          select: { id: true, rate: true, effectiveAt: true },
        }),
        this.lastDownload(code),
      ]);

      return {
        code,
        current: pin ? toView(pin as PinRow) : null,
        platformPin: platformPin ? toView(platformPin as PinRow) : null,
        lastAccepted: accepted
          ? {
              snapshotId: accepted.id,
              rate: accepted.rate.toString(),
              effectiveAt: accepted.effectiveAt.toISOString(),
            }
          : null,
        lastDownload: reading,
      };
    });
  }

  async pin(actor: PinActor, input: PinInput): Promise<PinView> {
    const scope = await this.access(actor);
    const currency = await this.pinnable(input.code, scope);

    let rate: Prisma.Decimal;
    try {
      rate = new Prisma.Decimal(input.rate).toDecimalPlaces(
        RATE_SCALE,
        Prisma.Decimal.ROUND_HALF_UP,
      );
    } catch {
      throw new CurrencyPinRefused('invalid_rate', input.rate);
    }
    if (!rate.isFinite() || rate.lte(0))
      throw new CurrencyPinRefused('invalid_rate', input.rate);

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
          // The tenant whose books it prices; null for the platform's (F-116-j).
          tenantId: scope.tenantId,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: actor.tenantId,
          adminId: actor.userId,
          action: AdminAction.currency_rate_pin,
          targetEntityType: AuditTargetType.currency_exchange_rate,
          targetEntityId: created.id,
          newValue: {
            code: input.code,
            rate: rate.toString(),
            expiresAt: expiresAt.toISOString(),
            scope: scope.kind,
          },
          reason: input.reason,
          adminIpAddress: actor.ip,
        },
      });
      return created;
    });

    this.logger.log(
      `${input.code} pinned at ${rate.toString()} until ${expiresAt.toISOString()} by ${actor.userId}`,
    );
    return toView({
      ...row,
      tenantId: scope.tenantId,
      currency: { code: input.code },
      pinEnd: null,
    } as PinRow);
  }

  async end(actor: PinActor, pinId: string): Promise<PinView> {
    const scope = await this.access(actor);
    const pin = (await tenantTransaction(this.prisma, (tx) =>
      tx.currencyExchangeRate.findUnique({
        where: { id: pinId },
        include: {
          currency: { select: { code: true } },
          pinEnd: { select: { endedAt: true } },
        },
      }),
    )) as PinRow | null;

    // Another tenant's pin, or the platform's to a tenant, is not found — not forbidden.
    if (
      !pin ||
      pin.source !== RateSource.manual_admin ||
      (pin.tenantId ?? null) !== scope.tenantId
    ) {
      throw new CurrencyPinRefused('pin_not_found', pinId);
    }
    if (pin.pinEnd || !pin.expiresAt || pin.expiresAt <= new Date())
      throw new CurrencyPinRefused('pin_over', pinId);

    try {
      const ended = await tenantTransaction(this.prisma, async (tx) => {
        const end = await tx.currencyRatePinEnd.create({
          data: { rateId: pin.id, endedById: actor.userId },
        });
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
      this.logger.log(
        `${pin.currency.code} pin ${pin.id} ended by ${actor.userId}`,
      );
      return toView({ ...pin, pinEnd: { endedAt: ended.endedAt } });
    } catch (e) {
      // Two admins ending the same pin: the unique `rateId` lets one through.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new CurrencyPinRefused('pin_over', pinId);
      }
      throw e;
    }
  }

  /**
   * The caller's scope. The platform owner pins for everyone; any other
   * tenant for its own books (F-116-j). `currency.pin` at the door decides who
   * inside a tenant may.
   */
  private async access(actor: PinActor): Promise<Scope> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { tenantType: true, operatingCurrencyCode: true },
    });
    if (!tenant)
      throw new CurrencyPinRefused('not_platform_owner', actor.tenantId);
    return tenant.tenantType === TenantType.platform_owner
      ? { kind: 'platform', tenantId: null }
      : {
          kind: 'tenant',
          tenantId: actor.tenantId,
          operatingCurrencyCode: tenant.operatingCurrencyCode,
        };
  }

  /**
   * An active, non-base currency — the base is 1 by definition — and, for a
   * tenant, one its books use: its operating currency, or one its own
   * gateways charge in (billing's answer; user, 2026-09-28).
   */
  private async pinnable(code: string, scope: Scope): Promise<{ id: string }> {
    const currency = await this.prisma.currency.findUnique({
      where: { code },
      select: { id: true, isActive: true, isBaseCurrency: true },
    });
    if (!currency || !currency.isActive)
      throw new CurrencyPinRefused('currency_not_found', code);
    if (currency.isBaseCurrency)
      throw new CurrencyPinRefused('base_currency', code);
    if (scope.kind === 'tenant' && code !== scope.operatingCurrencyCode) {
      const charged = await this.billing.chargeCurrencies(scope.tenantId);
      if (!charged.includes(code))
        throw new CurrencyPinRefused('currency_not_yours', code);
    }
    return currency;
  }

  /** `fx:reading:{code}`, written by the worker. Unreadable is simply absent. */
  private async lastDownload(code: string): Promise<PinForm['lastDownload']> {
    try {
      const raw = await this.redis.get(UnscopedRedisKeys.fxReading(code));
      return raw ? (JSON.parse(raw) as PinForm['lastDownload']) : null;
    } catch (err) {
      this.logger.warn(
        `${code} last download unreadable: ${(err as Error).message}`,
      );
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
