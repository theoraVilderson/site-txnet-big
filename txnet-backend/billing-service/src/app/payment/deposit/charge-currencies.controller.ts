import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { chargeCurrenciesOf, selectableGateways } from './deposit-pricing';

/**
 * `GET /api/internal/billing/tenants/:tenantId/charge-currencies` (F-116-j,
 * ADR-0100) — the currencies a tenant's selectable gateways charge in, for
 * currency-service to decide which currencies that tenant may pin a rate for.
 * Billing owns the gateways and the providers' charge currencies, so the
 * answer is computed here rather than copied there. Service token only.
 */
@TenantCapability('system')
@Controller('internal/billing/tenants/:tenantId/charge-currencies')
@UseGuards(ServiceOnlyGuard)
export class ChargeCurrenciesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  @Get()
  async list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string): Promise<{ currencies: string[] }> {
    // The gateway rows are under RLS: read as that tenant, as its own quote reads them.
    const gateways = await runWithTenant({ id: tenantId } as never, () =>
      tenantTransaction(this.prisma, (tx) => selectableGateways(tx, this.crossTenant, tenantId)),
    );
    return { currencies: chargeCurrenciesOf(gateways, this.providers) };
  }
}
