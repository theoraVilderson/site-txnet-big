import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';
import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { LinkedAccountService } from './linked-account.service';

export const ownerAccountSchema = z.object({
  credentialUserId: z.string().uuid(),
});

/**
 * The seam `tenant-service` makes a reseller's owner through (ADR-0059 (6)).
 *
 * `tenant-service` never writes `identity.user` (ADR-0058 (4)); it names the
 * reseller in `X-Tenant-Id`, honoured because the service token verified, and
 * the owner's platform account in the body. The account is created in that
 * ambient tenant — nothing here trusts the body for scope (ADR-0024).
 *
 * `system`: it follows a purchase or a platform-owner decision already taken,
 * so no status of the new reseller refuses it.
 */
@TenantCapability('system')
@Controller('internal/owner-accounts')
@UseGuards(ServiceOnlyGuard)
export class OwnerAccountInternalController {
  constructor(private readonly linkedAccounts: LinkedAccountService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(ownerAccountSchema))
    body: z.infer<typeof ownerAccountSchema>,
  ) {
    return this.linkedAccounts.createOwnerAccount(body.credentialUserId);
  }
}
