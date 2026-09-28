import { Injectable, Logger } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import {
  type CurrencyChangeSummary,
  type TenantCapabilityName,
  CurrencyChangeConflict,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  DERIVED_CURRENCIES,
  convertOperatingCurrency,
  holdsPermission,
  readFxPair,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * A tenant's operating currency (F-116-a, ADR-0098 part 1): the currency it
 * keeps its books in. The `platform_owner` row's is the platform's, and the
 * money between a tenant and the platform is in it (part 4).
 *
 * **Who.** A reseller's through {@link ResellerAccess}, as its branding is. The
 * platform's only by its own staff holding `tenant.manage` — `ResellerAccess`
 * admits resellers alone, and a reseller's admin holds `tenant.manage` in its
 * own tenant, never in the platform's.
 *
 * **Which.** Only a currency with a rate (part 8): active, at most two
 * decimals (money is `DECIMAL(18,2)`, part 6), and either the USD pivot or
 * holding an active rate row. The staleness ladder (F-0607-a) is not built;
 * when it is, "has a rate" is its answer.
 *
 * **What a change does** (F-116-f, part 5): the pair old -> new is read once,
 * and `convertOperatingCurrency` converts every live amount at it in one
 * transaction on the cross-tenant pool — the change spans every user of the
 * tenant and, for the platform, every reseller. History is left as written.
 * No rate for the pair refuses the change (`rate_unavailable`); a change that
 * lost a race to another is refused (`currency_changed`) rather than
 * converted at a rate read for the other's starting currency.
 */

export type OperatingCurrencyActor = ResellerActor;

export type CurrencyChoice = { code: string; name: string; symbol: string; decimalPlaces: number };

export type OperatingCurrencyView = {
  code: string;
  /** The currencies a set would accept, by code. */
  choices: CurrencyChoice[];
};

/** A set that changed the currency: what was converted, and at what rate (F-116-f). */
export type OperatingCurrencyChange = OperatingCurrencyView & {
  conversion: { changeId: string; fromCode: string; rate: string; summary: CurrencyChangeSummary } | null;
};

export type OperatingCurrencyRejection = ResellerAccessRejection | 'currency_unavailable' | 'rate_unavailable' | 'currency_changed';

export class OperatingCurrencyRefused extends Error {
  constructor(
    readonly reason: OperatingCurrencyRejection,
    detail = '',
  ) {
    super(`operating currency refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'OperatingCurrencyRefused';
  }
}

/** Money columns are `DECIMAL(18,2)` (ADR-0098 part 6). */
const MAX_DECIMALS = 2;

/**
 * The whole change runs in one transaction (user, 2026-09-28): set-based, so
 * seconds for a tenant with 100k wallets. The interactive default of 5s is
 * for a request, not for this.
 */
const CHANGE_TIMEOUT_MS = 120_000;

type Target = { id: string; code: string };

@Injectable()
export class TenantOperatingCurrencyService {
  private readonly logger = new Logger(TenantOperatingCurrencyService.name);

  constructor(
    private readonly resellerAccess: ResellerAccess,
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  async read(actor: OperatingCurrencyActor, tenantId: string): Promise<OperatingCurrencyView> {
    return this.view(await this.admit(actor, tenantId, 'read'), await this.choices());
  }

  async set(actor: OperatingCurrencyActor, tenantId: string, code: string, ip: string): Promise<OperatingCurrencyChange> {
    const target = await this.admit(actor, tenantId, 'staffWrite');
    const choices = await this.choices();
    if (!choices.some((c) => c.code === code)) throw new OperatingCurrencyRefused('currency_unavailable', code);
    if (code === target.code) return { code, choices, conversion: null };

    // Its own change is inside its own books: its own pin converts (F-116-j, ADR-0098 part 9).
    const pair = await readFxPair(this.all, this.redis, target.code, code, this.logger, { tenantId: target.id });
    if (!pair) throw new OperatingCurrencyRefused('rate_unavailable', `${target.code} -> ${code}`);
    let outcome;
    try {
      outcome = await this.all.$transaction(
        (tx) => convertOperatingCurrency(tx, { tenantId: target.id, toCode: code, pair, actorUserId: actor.userId, actorIp: ip }),
        { timeout: CHANGE_TIMEOUT_MS },
      );
    } catch (e) {
      if (e instanceof CurrencyChangeConflict) throw new OperatingCurrencyRefused('currency_changed', target.id);
      throw e;
    }
    const { changeId, fromCode, rate, summary } = outcome;
    // A retry that found the change already made converted nothing.
    const conversion = changeId && summary ? { changeId, fromCode, rate, summary } : null;
    this.logger.log(`operating currency of ${target.id} set ${target.code} -> ${code} at ${rate} by ${actor.userId}: ${JSON.stringify(summary)}`);
    return { code, choices, conversion };
  }

  private view(target: Target, choices: CurrencyChoice[]): OperatingCurrencyView {
    return { code: target.code, choices };
  }

  private async choices(): Promise<CurrencyChoice[]> {
    const rows = await this.all.currency.findMany({
      where: { isActive: true },
      select: {
        code: true,
        name: true,
        symbol: true,
        decimalPlaces: true,
        isActive: true,
        isBaseCurrency: true,
        exchangeRates: { where: { isActive: true }, select: { id: true }, take: 1 },
      },
      orderBy: { code: 'asc' },
    });
    // A tied currency (the toman, F-116-m) has no row of its own: it has a rate while its root does.
    const rated = new Set(rows.filter((c) => c.isBaseCurrency || c.exchangeRates.length > 0).map((c) => c.code));
    return rows
      .filter((c) => c.isActive && c.decimalPlaces <= MAX_DECIMALS && rated.has(DERIVED_CURRENCIES[c.code]?.of ?? c.code))
      .map(({ code, name, symbol, decimalPlaces }) => ({ code, name, symbol, decimalPlaces }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  private async admit(actor: OperatingCurrencyActor, tenantId: string, capability: TenantCapabilityName): Promise<Target> {
    const tenant = await this.all.tenant.findUnique({
      where: { id: tenantId },
      select: { tenantType: true, deletedAt: true, operatingCurrencyCode: true },
    });
    if (tenant?.tenantType === TenantType.platform_owner && !tenant.deletedAt) {
      if (actor.tenantId !== tenantId || !holdsPermission(actor.permissions, 'tenant.manage')) {
        throw new OperatingCurrencyRefused('not_allowed', tenantId);
      }
      return { id: tenantId, code: tenant.operatingCurrencyCode };
    }
    try {
      const reseller = await this.resellerAccess.admit(actor, tenantId, capability);
      return { id: reseller.id, code: tenant?.operatingCurrencyCode ?? 'USD' };
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new OperatingCurrencyRefused(e.reason, tenantId);
      throw e;
    }
  }
}
