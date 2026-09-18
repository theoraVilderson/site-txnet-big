import { Module } from '@nestjs/common';
import {
  CredentialEnvGuard,
  CredentialVaultService,
  KekService,
  VAULT_DB,
} from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';

/**
 * The Credential Vault (ADR-0026, catalog 20.4), as `auth-service` reads it.
 *
 * The vault itself is `shared-core/src/lib/tenant/vault/` since F-092-f
 * (ADR-0039). What stays here is this service's own reading of it: the bot
 * directory and the SMS sender resolve through it. **It serves no route**:
 * the retention sweep and the gateway-secret writer moved to
 * `tenant-service` with F-018-ab (ADR-0058 (2)).
 *
 * `VAULT_DB` is the cross-tenant pool, because the readers here resolve a
 * tenant *through* the vault: `messenger`'s bot directory looks a credential
 * up for a webhook before any tenant is known (F-066-i).
 *
 * `CredentialEnvGuard` is a provider with no consumer on purpose: it exists
 * to run its `onModuleInit` and refuse the boot (F-1216). A service that loads
 * the vault is exactly the service the rule has to hold for.
 *
 * `PrismaModule` is `@Global`, so it is not imported here.
 */
@Module({
  providers: [
    KekService,
    CredentialVaultService,
    CredentialEnvGuard,
    { provide: VAULT_DB, useExisting: CrossTenantPrismaService },
  ],
  exports: [CredentialVaultService, KekService],
})
export class VaultModule {}
