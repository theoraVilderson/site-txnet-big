import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { TenantCapability } from '@txnet-backend/shared-core';
import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { TenantAgnostic } from '../tenant-agnostic.decorator';
import { RenewalOutcome, RenewalSweep, TenantRenewalService } from './tenant-renewal.service';

/**
 * The renewal's two internal routes (F-019-c), reached only by `worker-service`
 * with `SERVICE_AUTH_TOKEN` — any other caller gets a 404 indistinguishable
 * from no route.
 *
 * `renew-due` is the sweep the `tenant_subscription_renewal` job ticks;
 * `:tenantId/renew` is what a `tenant.billing.credited` event asks for, so a
 * payment is charged at once rather than at the next tick. Both repeat safely.
 *
 * `@TenantAgnostic` and `system`: the sweep spans every reseller, and the one
 * it names is exactly the suspended one a payment must reach.
 */
@TenantCapability('system')
@Controller('internal/tenant-subscriptions')
@UseGuards(ServiceOnlyGuard)
@TenantAgnostic()
export class TenantRenewalInternalController {
  constructor(private readonly renewal: TenantRenewalService) {}

  @Post('renew-due')
  @HttpCode(HttpStatus.OK)
  renewDue(): Promise<RenewalSweep> {
    return this.renewal.renewDue();
  }

  @Post(':tenantId/renew')
  @HttpCode(HttpStatus.OK)
  async renew(@Param('tenantId', new ParseUUIDPipe()) tenantId: string): Promise<{ outcome: RenewalOutcome }> {
    return { outcome: await this.renewal.renew(tenantId) };
  }
}
