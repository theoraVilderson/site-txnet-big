import { Injectable, Logger } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import {
  type TenantCapabilityName,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  holdsPermission,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

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
 * **When.** Until F-116-f converts live money, a change is refused while the
 * tenant has any: a user's ledger row, an invoice, a payment, a price or a
 * metered rate — and for the platform, also any tenant ↔ platform money
 * (a reseller billing ledger row, a package sold to resellers) and the
 * platform-wide prices (`tenantId` null). A reseller's own billing wallet is
 * in the platform's currency, so it does not count against the reseller.
 * The check and the write are not one transaction: a first payment landing
 * between them is accepted as F-116-f's to convert.
 */

export type OperatingCurrencyActor = ResellerActor;

export type CurrencyChoice = { code: string; name: string; symbol: string; decimalPlaces: number };

export type OperatingCurrencyView = {
  code: string;
  /** `false` while the tenant has money (until F-116-f). */
  changeable: boolean;
  /** The currencies a set would accept, by code. */
  choices: CurrencyChoice[];
};

export type OperatingCurrencyRejection = ResellerAccessRejection | 'currency_unavailable' | 'tenant_has_money';

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

type Target = { id: string; platform: boolean; code: string };

@Injectable()
export class TenantOperatingCurrencyService {
  private readonly logger = new Logger(TenantOperatingCurrencyService.name);

  constructor(
    private readonly resellerAccess: ResellerAccess,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async read(actor: OperatingCurrencyActor, tenantId: string): Promise<OperatingCurrencyView> {
    return this.view(await this.admit(actor, tenantId, 'read'));
  }

  async set(actor: OperatingCurrencyActor, tenantId: string, code: string): Promise<OperatingCurrencyView> {
    const target = await this.admit(actor, tenantId, 'staffWrite');
    const choices = await this.choices();
    if (!choices.some((c) => c.code === code)) throw new OperatingCurrencyRefused('currency_unavailable', code);
    if (code === target.code) return this.view(target, choices);
    if (await this.hasMoney(target)) throw new OperatingCurrencyRefused('tenant_has_money', target.id);
    await this.all.tenant.update({ where: { id: target.id }, data: { operatingCurrencyCode: code } });
    this.logger.log(`operating currency of ${target.id} set ${target.code} -> ${code} by ${actor.userId}`);
    return this.view({ ...target, code }, choices);
  }

  private async view(target: Target, choices?: CurrencyChoice[]): Promise<OperatingCurrencyView> {
    const [list, money] = await Promise.all([choices ?? this.choices(), this.hasMoney(target)]);
    return { code: target.code, changeable: !money, choices: list };
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
    return rows
      .filter((c) => c.isActive && c.decimalPlaces <= MAX_DECIMALS && (c.isBaseCurrency || c.exchangeRates.length > 0))
      .map(({ code, name, symbol, decimalPlaces }) => ({ code, name, symbol, decimalPlaces }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  /** Any money the change would reinterpret — see the class comment for the list. */
  private async hasMoney({ id, platform }: Target): Promise<boolean> {
    const own = platform ? { OR: [{ tenantId: id }, { tenantId: null }] } : { tenantId: id };
    const pick = { select: { id: true } } as const;
    const probes: Promise<unknown>[] = [
      this.all.walletTransaction.findFirst({ where: { wallet: { owner: { tenantId: id } } }, ...pick }),
      this.all.invoice.findFirst({ where: { tenantId: id }, ...pick }),
      this.all.paymentTransaction.findFirst({ where: { tenantId: id }, ...pick }),
      this.all.price.findFirst({ where: own, ...pick }),
      this.all.meteredRate.findFirst({ where: own, ...pick }),
    ];
    if (platform) {
      probes.push(this.all.tenantBillingTransaction.findFirst(pick), this.all.tenantFeaturePackage.findFirst(pick));
    }
    return (await Promise.all(probes)).some((row) => row !== null);
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
      return { id: tenantId, platform: true, code: tenant.operatingCurrencyCode };
    }
    try {
      const reseller = await this.resellerAccess.admit(actor, tenantId, capability);
      return { id: reseller.id, platform: false, code: tenant?.operatingCurrencyCode ?? 'USD' };
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new OperatingCurrencyRefused(e.reason, tenantId);
      throw e;
    }
  }
}
