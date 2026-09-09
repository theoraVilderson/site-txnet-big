import { Module } from '@nestjs/common';
import { CredentialVaultService } from './credential-vault.service';
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
 * It has no controller. The admin surface that configures a credential is
 * F-018, and giving the vault an HTTP route before the surface that needs one
 * exists would be inventing an endpoint (§11).
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
  providers: [KekService, CredentialVaultService, CredentialEnvGuard],
  exports: [CredentialVaultService, KekService],
})
export class VaultModule {}
