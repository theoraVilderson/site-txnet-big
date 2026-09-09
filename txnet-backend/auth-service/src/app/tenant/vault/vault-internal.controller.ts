import { Controller, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { TenantAgnostic } from '../tenant-agnostic.decorator';
import { CredentialVaultService } from './credential-vault.service';

/**
 * The vault's one internal route (F-031-c), and the reason it now has a
 * controller at all.
 *
 * `VaultModule` deliberately had none: an endpoint before a caller is an
 * invented endpoint (§11), and the admin surface that configures a credential
 * is still F-018. This is not that surface. It is the seam a **scheduler**
 * reaches the vault through, and it exists because ADR-0026 rule 4 puts the
 * obligation to destroy a superseded version on whoever schedules workers —
 * `automation`, whose jobs run in `worker-service`, which cannot import this
 * code because an Nx app cannot import an Nx app.
 *
 * **What it hands back is a count.** No credential, no fingerprint, no tenant
 * id, nothing that names what was destroyed — a sweep's answer is how many,
 * and anything more would be a disclosure this route has no reason to make.
 * That is what separates it from the two internal routes that do return a
 * plaintext (`automation`'s `BotIntegrationController`): those had to argue
 * their way past F-323, and this one has nothing to argue about.
 *
 * `@TenantAgnostic` because the sweep is platform-wide by construction: it
 * looks for rows whose grace window has passed, in every tenant, and there is
 * no tenant a caller could name that would make it correct. Guarded by
 * `ServiceOnlyGuard`, so an unrecognised caller gets a 404 that is
 * indistinguishable from a route that does not exist.
 */
@Controller('internal/vault')
@UseGuards(ServiceOnlyGuard)
@TenantAgnostic()
export class VaultInternalController {
  constructor(private readonly vault: CredentialVaultService) {}

  /**
   * Destroy every superseded credential version whose rotation grace window has
   * passed (ADR-0026 rule 4, `ROTATION_GRACE_SEC`).
   *
   * Idempotent by nature — a second call inside the same window destroys
   * nothing and answers 0 — which is what lets the caller be an at-least-once
   * queue consumer (ADR-0027).
   */
  @Post('destroy-expired')
  async destroyExpired(): Promise<{ destroyed: number }> {
    return { destroyed: await this.vault.destroyExpiredVersions() };
  }
}
