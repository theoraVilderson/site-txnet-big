import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectionTestFault, CounterSemantics, DriverType, PanelReviewState, PanelRole, PanelTransport, type Prisma } from '@prisma/client';
import { panelCredentialRef, PanelSecret, panelRadiusSecretRef } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import { assertPanelRoom } from '../entitlement/reseller-room';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { claimingAddress, claimingPushAddress } from './panel-address';
import { panelScopeOf, PanelScope, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

/** A panel as its owner declares it. The questionnaire is the connection test's to answer, not this. */
export type RegisterPanelInput = {
  name: string;
  /** The NAS's allowlist entry: required for a push panel, optional for a pull one (F-027-br). */
  ipAddress?: string | null;
  apiBaseUrl?: string | null;
  /** Where users are served their links, for a family that serves them apart from its API (F-027-bg). */
  clientBaseUrl?: string | null;
  driverType: DriverType;
  counterSemantics: CounterSemantics;
  transport: PanelTransport;
  role: PanelRole;
  region: string;
  maxRequestsPerMinute?: number;
  /** The panel's login, opaque to us. Relayed to the vault once and kept nowhere. */
  credentials: string;
  /** A push panel's RADIUS shared secret (F-027-az), relayed the same way. Absent on a pull panel. */
  radiusSecret?: string;
};

/** Whose panel a registration writes, and the tenant its secrets are sealed under in the vault. */
export type PanelOwner = { scope: PanelScope; vaultTenantId: string };

/** What the vault says about a stored login: no value, no fingerprint. */
export type PanelCredentialState = { configured: boolean; version: number | null; rotatedAt: string | null };

/** The write seam on `tenant-service` (`/internal/vault/panel-credential`), as this service sees it. */
export interface PanelCredentialWriter {
  set(target: { tenantId: string; panelId: string }, credentials: string, actorId: string, secret: PanelSecret): Promise<PanelCredentialState>;
}

export const PANEL_CREDENTIAL_WRITER = Symbol('PANEL_CREDENTIAL_WRITER');

/** Why a re-submitted login is refused, beyond the scope's own refusals. */
export type ResubmitRejection = 'panel_refused' | 'panel_not_push';

export class PanelResubmitRefused extends Error {
  constructor(readonly reason: ResubmitRejection) {
    super(reason);
    this.name = 'PanelResubmitRefused';
  }
}

/**
 * Registering a panel (F-027-ar, ADR-0080 decision 1): a desired-state write.
 *
 * The row lands `pending` and this is all that happens here. `network-service`
 * finds it on its next tick, runs the connection test and writes the verdict
 * (`network/contract.registration.md`); nothing calls the Go service, which by
 * ADR-0071 has no route to call.
 *
 * **Scoped by tenant from the first line** (decision 2, ADR-0166). The
 * platform owner writes the platform's panel (`ownershipType = platform`,
 * `tenantId` null — network invariant 9); a reseller, behind its own door
 * (`systems-door.ts`), its own (`{tenant, tenantId}`), under `panels_max`.
 * The collector dials it through the bare guard (ADR-0095).
 *
 * **The login goes to the vault and nowhere else.** `panelApiCredentials`
 * holds {@link panelCredentialRef}; the login itself is relayed to
 * `tenant-service`'s writer, which re-derives that the named tenant owns the
 * panel before storing it (the gateway seam's shape, D-31). Row first, vault
 * second, because the writer checks the row exists; a vault that fails
 * deletes the row again, so no tick ever tests a panel whose login was never
 * stored.
 *
 * Every panel read and write goes through the cross-tenant pool, the scope
 * `panelScopeOf` answered in its `where`: a platform panel's `tenantId` is
 * null, which `network.panel`'s RLS `WITH CHECK` refuses on the app pool
 * (20260909001500, list B: shared-read), and a reseller's is invisible there.
 */
@Injectable()
export class PanelRegistrationService {
  private readonly logger = new Logger(PanelRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** The platform owner's pool, for the panel writes only. */
    private readonly all: CrossTenantPrismaService,
    @Inject(PANEL_CREDENTIAL_WRITER) private readonly vault: PanelCredentialWriter,
  ) {}

  async register(actor: SystemsActor, input: RegisterPanelInput) {
    const scope = await panelScopeOf(this.prisma, actor);
    return this.registerFor({ scope, vaultTenantId: actor.tenantId }, actor.adminId, input);
  }

  /**
   * {@link register} for an owner already admitted: the platform's, or a
   * reseller's own router through the import's door (ADR-0162), which is
   * written under the reseller and its login sealed under it.
   */
  async registerFor(owner: PanelOwner, adminId: string, input: RegisterPanelInput) {
    const { scope, vaultTenantId } = owner;
    const id = randomUUID();

    // Registered once (F-027-cd; a push panel's IP, F-027-ff): 409 `panel_already_registered`, naming the holder if it is ours to see.
    const pushAddress = input.transport === PanelTransport.push ? input.ipAddress : null;
    const data = {
      id,
      ...scope,
      name: input.name,
      ipAddress: input.ipAddress ?? null,
      apiBaseUrl: input.apiBaseUrl ?? null,
      clientBaseUrl: input.clientBaseUrl ?? null,
      driverType: input.driverType,
      counterSemantics: input.counterSemantics,
      transport: input.transport,
      role: input.role,
      region: input.region,
      ...(input.maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute: input.maxRequestsPerMinute } : {}),
      reviewState: PanelReviewState.pending,
      panelApiCredentials: panelCredentialRef(vaultTenantId, id),
      ...(input.radiusSecret !== undefined ? { panelRadiusSecret: panelRadiusSecretRef(vaultTenantId, id) } : {}),
    };
    await claimingAddress(this.all, scope, input.apiBaseUrl, null, () =>
      claimingPushAddress(this.all, scope, pushAddress, null, () => this.createWithinLimit(scope, data)),
    );

    const target = { tenantId: vaultTenantId, panelId: id };
    let credentials: PanelCredentialState;
    let radiusSecret: PanelCredentialState | undefined;
    try {
      credentials = await this.vault.set(target, input.credentials, adminId, 'login');
      if (input.radiusSecret !== undefined) radiusSecret = await this.vault.set(target, input.radiusSecret, adminId, 'radius_secret');
    } catch (err) {
      // A login already stored stays in the vault under a panel id nothing
      // names any more: unreachable, and never read.
      await this.all.panel.delete({ where: { id } });
      throw err;
    }

    this.logger.log(`panel ${id} (${input.driverType}) registered by ${adminId}; pending its connection test`);
    return { id, reviewState: PanelReviewState.pending, credentials, ...(radiusSecret ? { radiusSecret } : {}) };
  }

  /**
   * The row itself: a platform panel as it is, a reseller's own only under
   * its `panels_max` (BYO-1-a, ADR-0166 point 4) — counted and written in one
   * transaction behind the reseller's limit lock, so two registrations racing
   * for the last seat cannot both land. Before the vault, so a refusal stores
   * no login.
   */
  private createWithinLimit(scope: PanelScope, data: Prisma.PanelUncheckedCreateInput) {
    const { tenantId } = scope;
    if (tenantId === null) return this.all.panel.create({ data });
    return this.all.$transaction(async (tx) => {
      await assertPanelRoom(tx, tenantId);
      return tx.panel.create({ data });
    });
  }

  /**
   * Re-submitting a panel's login (F-027-au): rotated in the vault (`put` is
   * also rotate, `tenant/contract.vault.md` rule 3), then — only on a panel
   * still `pending` — the last connection test is cleared, so the next tick
   * tests the corrected login instead of waiting out its retry
   * (`network/contract.registration.md` rule 4).
   *
   * - An **accepted** panel is rotated and nothing else: collection reads only
   *   an accepted panel (invariant 44), and a password change must not stop it.
   * - A **refused** panel is 409 `panel_refused`: it was refused on its answers,
   *   and a new login changes none of them. Nothing is written.
   * - A **`rate_limited`** fault keeps its time. It is not a bad login, and
   *   retrying through a ban is what makes it permanent.
   *
   * Vault first, row second: a vault that fails leaves the row as it was. The
   * clear is conditional on `pending`, so a verdict the tick wrote meanwhile
   * stands, and `retest` says whether the clear landed.
   */
  async resubmitCredentials(actor: SystemsActor, panelId: string, credentials: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    return this.resubmitFor({ scope, vaultTenantId: actor.tenantId }, actor.adminId, panelId, credentials);
  }

  /** {@link resubmitCredentials} for an owner already admitted, as {@link registerFor}. */
  async resubmitFor(owner: PanelOwner, adminId: string, panelId: string, credentials: string) {
    const { scope, vaultTenantId } = owner;
    // Read on the cross-tenant pool, the scope in the `where`: `tenant_isolation`
    // hides a reseller's panel from a bare app-pool read (ADR-0162).
    const where = { id: panelId, ...scope };
    const panel = await this.all.panel.findFirst({ where, select: { reviewState: true, connectionTestFault: true } });
    if (!panel) throw new SystemsRefused('not_found');
    if (panel.reviewState === PanelReviewState.refused) throw new PanelResubmitRefused('panel_refused');

    const stored = await this.vault.set({ tenantId: vaultTenantId, panelId }, credentials, adminId, 'login');

    let reviewState: PanelReviewState = panel.reviewState;
    let retest = false;
    if (panel.reviewState === PanelReviewState.pending && panel.connectionTestFault !== ConnectionTestFault.rate_limited) {
      const cleared = await this.all.panel.updateMany({
        where: { ...where, reviewState: PanelReviewState.pending },
        data: { connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null },
      });
      retest = cleared.count > 0;
      if (!retest) reviewState = (await this.all.panel.findFirst({ where, select: { reviewState: true } }))?.reviewState ?? reviewState;
    }

    this.logger.log(`panel ${panelId}: login re-submitted by ${adminId}${retest ? '; re-tested on the next tick' : ''}`);
    return { id: panelId, reviewState, retest, credentials: stored };
  }

  /**
   * Re-submitting a push panel's RADIUS secret (F-027-az). The NAS's secret
   * is not what the connection test signs in with, so nothing is re-tested and
   * the review is not touched; the allowlist reads the new secret on its next
   * refresh (`network/contract.collection.md`).
   *
   * - A **pull** panel is 409 `panel_not_push`: it has no NAS, and the column
   *   refuses a reference (`panel_radius_secret_is_push_only`).
   * - A **refused** panel is 409 `panel_refused`, as for the login.
   * - A push panel registered before this route existed has no reference;
   *   it gets one here, **after** the vault answered, so a row never names a
   *   secret the vault does not hold.
   */
  async resubmitRadiusSecret(actor: SystemsActor, panelId: string, radiusSecret: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    const where = { id: panelId, ...scope };
    const panel = await this.all.panel.findFirst({
      where,
      select: { transport: true, reviewState: true, panelRadiusSecret: true },
    });
    if (!panel) throw new SystemsRefused('not_found');
    if (panel.transport !== PanelTransport.push) throw new PanelResubmitRefused('panel_not_push');
    if (panel.reviewState === PanelReviewState.refused) throw new PanelResubmitRefused('panel_refused');

    const stored = await this.vault.set({ tenantId: actor.tenantId, panelId }, radiusSecret, actor.adminId, 'radius_secret');
    if (panel.panelRadiusSecret === null) {
      await this.all.panel.update({ where: { id: panelId }, data: { panelRadiusSecret: panelRadiusSecretRef(actor.tenantId, panelId) } });
    }

    this.logger.log(`panel ${panelId}: RADIUS secret re-submitted by ${actor.adminId}`);
    return { id: panelId, reviewState: panel.reviewState, radiusSecret: stored };
  }
}
