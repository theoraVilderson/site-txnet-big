import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { GatewayAdminController } from './gateway-admin.controller';
import { GATEWAY_SECRET_WRITER, GatewayAdminService } from './gateway-admin.service';
import { ResellerGatewayController } from './reseller-gateway.controller';
import { ResellerGatewayService } from './reseller-gateway.service';
import { VaultSecretClient } from './vault-secret.client';

/**
 * Gateway management (F-102-b/c, D-31).
 *
 * No imports: `PrismaModule` is `@Global()` and `ConfigModule` is global. It
 * does not import `GatewayModule` on purpose — that module loads the vault to
 * **read** a merchant id at payment time, and nothing here reads one. The write
 * side is `VaultSecretClient`, a call to `tenant-service` (F-102-a, F-018-ab).
 *
 * Two controllers over one service (F-066-w3, ADR-0064): the ambient surface a
 * tenant configures itself through, and the one that names a reseller in its
 * path. `ResellerAccess` is the second one's door; its reader is bound beside
 * the Prisma pools.
 */
@Module({
  controllers: [GatewayAdminController, ResellerGatewayController],
  providers: [
    GatewayAdminService,
    ResellerGatewayService,
    ResellerAccess,
    VaultSecretClient,
    { provide: GATEWAY_SECRET_WRITER, useExisting: VaultSecretClient },
  ],
})
export class GatewayAdminModule {}
