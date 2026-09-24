import { Module } from '@nestjs/common';
import {
  CredentialEnvGuard,
  CredentialVaultService,
  KekService,
  VAULT_DB,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { GatewayCredentialController } from './gateway-credential.controller';
import { GatewayCredentialService } from './gateway-credential.service';
import { PanelCredentialController } from './panel-credential.controller';
import { PanelCredentialService } from './panel-credential.service';
import { VaultInternalController } from './vault-internal.controller';

/**
 * The Credential Vault's internal seams (ADR-0026, ADR-0039), out of
 * `auth-service` with F-018-ab (ADR-0058 (2)): writing a gateway's secrets is
 * tenant administration, not authentication.
 *
 * Three controllers, all service-only: the retention sweep `worker-service`
 * ticks (F-031-c), and the gateway-secret and panel-login writers
 * `billing-service` relays through (F-102-a, D-31; F-027-ar). `auth-service` still loads the vault itself — its
 * bot directory and SMS sender read through it — but serves no route on it.
 *
 * `VAULT_DB` is the cross-tenant pool: the sweep spans every tenant, and the
 * writer re-derives a gateway's owner before it has a tenant to bind to.
 *
 * `CredentialEnvGuard` is a provider with no consumer on purpose: it exists
 * to run its `onModuleInit` and refuse the boot (F-1216). A service that loads
 * the vault is exactly the service the rule has to hold for.
 *
 * `PrismaModule` is `@Global`, so it is not imported here.
 */
@Module({
  controllers: [VaultInternalController, GatewayCredentialController, PanelCredentialController],
  providers: [
    KekService,
    CredentialVaultService,
    GatewayCredentialService,
    PanelCredentialService,
    CredentialEnvGuard,
    { provide: VAULT_DB, useExisting: CrossTenantPrismaService },
  ],
})
export class VaultModule {}
