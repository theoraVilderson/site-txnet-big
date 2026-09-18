import { Module } from '@nestjs/common';

import { GatewayAdminController } from './gateway-admin.controller';
import { GATEWAY_SECRET_WRITER, GatewayAdminService } from './gateway-admin.service';
import { VaultSecretClient } from './vault-secret.client';

/**
 * Gateway management (F-102-b/c, D-31).
 *
 * No imports: `PrismaModule` is `@Global()` and `ConfigModule` is global. It
 * does not import `GatewayModule` on purpose — that module loads the vault to
 * **read** a merchant id at payment time, and nothing here reads one. The write
 * side is `VaultSecretClient`, a call to `tenant-service` (F-102-a, F-018-ab).
 */
@Module({
  controllers: [GatewayAdminController],
  providers: [GatewayAdminService, VaultSecretClient, { provide: GATEWAY_SECRET_WRITER, useExisting: VaultSecretClient }],
})
export class GatewayAdminModule {}
