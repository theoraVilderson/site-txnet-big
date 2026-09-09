import { Module } from '@nestjs/common';
import { CredentialVaultService } from './credential-vault.service';
import { VaultInternalController } from './vault-internal.controller';
import { CredentialEnvGuard } from './credential-env';
import { KekService } from './kek.service';

/**
 * The Credential Vault (ADR-0026, catalog 20.4).
 *
 * A module of its own rather than two more providers on `TenantModule`,
 * because the set of things that will read it is not the set of things that
 * resolve a tenant: `messenger` reads a bot token (F-066-i), `network` reads a
 * panel login, `billing` reads a gateway key. Each of those imports this and
 * gets exactly the vault, with no guard and no resolver riding along.
 *
 * Its one controller is a **seam, not a surface**. The admin surface that
 * configures a credential is still F-018; what F-031-c added is the single
 * service-only route a scheduler destroys expired versions through, because
 * the scheduler runs in another Nx application and ADR-0026 rule 4 puts that
 * obligation on it. See `vault-internal.controller.ts` for why that is one
 * route and not a resource.
 *
 * `CredentialEnvGuard` is a provider with no consumer on purpose: it exists
 * to run its `onModuleInit` and refuse the boot (F-1216). It lives here rather
 * than beside `env.validation.ts` because what it enforces is a property of
 * the vault — a credential belongs to a tenant, so it belongs in here — and
 * because a service that imports the vault is exactly the service the rule has
 * to hold for.
 *
 * `PrismaModule` is `@Global`, so it is not imported here.
 */
@Module({
  controllers: [VaultInternalController],
  providers: [KekService, CredentialVaultService, CredentialEnvGuard],
  exports: [CredentialVaultService, KekService],
})
export class VaultModule {}
