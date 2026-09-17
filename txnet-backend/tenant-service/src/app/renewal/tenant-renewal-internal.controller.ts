import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard } from '@txnet-backend/shared-core';

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
 * No tenant is in scope here: `internal/*` is outside `IdentityMiddleware`
 * (F-018-t), so `TenantStatusGuard` does not judge these routes — which is
 * what the sweep needs, since the tenants it must reach are the suspended
 * ones. `auth-service` said the same with `@TenantAgnostic` and
 * `@TenantCapability('system')`, against guards this app does not run.
 */
@Controller('internal/tenant-subscriptions')
@UseGuards(ServiceOnlyGuard)
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
