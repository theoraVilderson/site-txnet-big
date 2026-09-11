import { Module } from '@nestjs/common';
import {
  CredentialEnvGuard,
  CredentialVaultService,
  KekService,
  VAULT_DB,
} from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { VaultInternalController } from './vault-internal.controller';

/**
 * The Credential Vault (ADR-0026, catalog 20.4), as `auth-service` hosts it.
 *
 * The vault itself is `shared-core/src/lib/tenant/vault/` since F-092-f
 * (ADR-0039): `billing-service` reads a gateway's merchant id with its own KEK.
 * What stays here is what is this service's alone — which pool the vault
 * queries through, and the one internal route.
 *
 * `VAULT_DB` is the cross-tenant pool, because the readers here resolve a
 * tenant *through* the vault: `messenger`'s bot directory looks a credential
 * up for a webhook before any tenant is known (F-066-i).
 *
 * Its one controller is a **seam, not a surface**. The admin surface that
 * configures a credential is still F-018; what F-031-c added is the single
 * service-only route a scheduler destroys expired versions through, because
 * the scheduler runs in another Nx application and ADR-0026 rule 4 puts that
 * obligation on it. See `vault-internal.controller.ts` for why that is one
 * route and not a resource.
 *
 * `CredentialEnvGuard` is a provider with no consumer on purpose: it exists
 * to run its `onModuleInit` and refuse the boot (F-1216). A service that loads
 * the vault is exactly the service the rule has to hold for.
 *
 * `PrismaModule` is `@Global`, so it is not imported here.
 */
@Module({
  controllers: [VaultInternalController],
  providers: [
    KekService,
    CredentialVaultService,
    CredentialEnvGuard,
    { provide: VAULT_DB, useExisting: CrossTenantPrismaService },
  ],
  exports: [CredentialVaultService, KekService],
})
export class VaultModule {}
