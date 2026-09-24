import { Injectable } from '@nestjs/common';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  TenantCapabilityName,
} from '@txnet-backend/shared-core';

import type { GatewaySource } from '../gateway/gateway-merchant';
import {
  CreateGatewayInput,
  GatewayActor,
  GatewayAdminRefused,
  GatewayAdminRejection,
  GatewayAdminService,
  GatewayRef,
  GatewayView,
  UpdateGatewayInput,
} from './gateway-admin.service';

/** The caller, as `forward-auth` proved them, plus the address a write is audited from. */
export type ResellerGatewayActor = ResellerActor & { ip: string };

/** Both doors' refusals: who may configure this reseller, and what may be done to a gateway. */
export type ResellerGatewayRejection = ResellerAccessRejection | GatewayAdminRejection;

/** A refusal, carrying the reason of whichever door closed. */
export class ResellerGatewayRefused extends Error {
  constructor(
    readonly reason: ResellerGatewayRejection,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ResellerGatewayRefused';
  }
}

/** A create body on this surface: `tenantId` is the path's, so it is not a key a client may send. */
export type ResellerCreateGatewayInput = Omit<CreateGatewayInput, 'tenantId'>;

/**
 * Gateway management for the reseller a route **names** (F-066-w3, ADR-0064):
 * `/api/billing/tenants/:tenantId/gateways`. The ambient
 * `/api/billing/gateways` is untouched and stays what a tenant configuring
 * itself uses.
 *
 * **It adds a door and a scope, and no rules.** {@link ResellerAccess} (tenant
 * invariant 21) says whether this caller may configure that reseller — its
 * owner, one of its staff seats holding `tenant.manage`, or the platform
 * owner's staff — and `run` opens the reseller's tenant scope around the work.
 * Inside it, {@link GatewayAdminService} is called with the **reseller** as the
 * actor's tenant, so every rule of the ambient surface applies here by
 * construction rather than by being restated: a tenant's own rows only, the app
 * pool inside a `tenantTransaction`, secrets to the vault and never back,
 * `gateway_has_open_payments` on delete, and one `admin_audit_log` row per
 * write — in the **reseller's** tenant, naming the caller as its admin.
 *
 * **Nothing here is elevated.** The actor handed on is a reseller, never the
 * platform owner, so the two rules that turn on that difference hold unchanged:
 * `verificationStatus` is `verification_is_platform_owners` on this surface for
 * everyone, platform staff included — verifying a gateway is done on the
 * ambient route, as the platform owner — and a `platform` source is
 * `not_platform_owner` on create, `gateway_not_found` on anything else.
 *
 * **The tenant is the path's.** The reseller's owner is a user of the platform
 * owner's tenant (ADR-0059), so neither the session's `X-Tenant-Id` nor a
 * body's `tenantId` may choose the tenant: `create` is given the admitted
 * reseller's id, whatever the body held.
 *
 * Capabilities are the reseller's own status matrix: `read` for a list, so a
 * suspended reseller can still see what it has, `staffWrite` for every write,
 * which a suspended reseller cannot do — the same pair `tenant-service` uses
 * for a reseller's domains and branding.
 */
@Injectable()
export class ResellerGatewayService {
  constructor(
    private readonly access: ResellerAccess,
    private readonly gateways: GatewayAdminService,
  ) {}

  list(actor: ResellerGatewayActor, tenantId: string): Promise<GatewayView[]> {
    // No filter: `list` answers the actor's own tenant, which is the reseller.
    return this.run(actor, tenantId, 'read', (as) => this.gateways.list(as));
  }

  presets(actor: ResellerGatewayActor, tenantId: string): Promise<string[]> {
    return this.run(actor, tenantId, 'read', (as) => this.gateways.presets(as));
  }

  setPresets(actor: ResellerGatewayActor, tenantId: string, values: string[]): Promise<string[]> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.gateways.setPresets(as, values));
  }

  tax(actor: ResellerGatewayActor, tenantId: string): Promise<string | null> {
    return this.run(actor, tenantId, 'read', (as) => this.gateways.tax(as));
  }

  setTax(actor: ResellerGatewayActor, tenantId: string, value: string | null): Promise<string | null> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.gateways.setTax(as, value));
  }

  create(actor: ResellerGatewayActor, tenantId: string, input: ResellerCreateGatewayInput): Promise<GatewayView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.gateways.create(as, { ...input, tenantId: as.tenantId }));
  }

  update(actor: ResellerGatewayActor, tenantId: string, ref: GatewayRef, patch: UpdateGatewayInput): Promise<GatewayView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.gateways.update(as, ref, patch));
  }

  remove(
    actor: ResellerGatewayActor,
    tenantId: string,
    ref: GatewayRef,
  ): Promise<{ id: string; source: GatewaySource; mode: 'deleted' | 'deactivated'; grantsWithdrawn: number }> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.gateways.remove(as, ref));
  }

  /**
   * Admit, open the reseller's scope, then work — `ResellerAccess.run`, with
   * both doors' refusals turned into this surface's one type so the controller
   * has a single map from reason to status.
   *
   * The work `await`s inside itself, as `runWithTenant` requires: a Prisma
   * promise returned unawaited would run after the scope has closed.
   */
  private async run<T>(
    actor: ResellerGatewayActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (as: GatewayActor) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, capability, (reseller) =>
        work({ adminId: actor.userId, tenantId: reseller.id, ip: actor.ip }),
      );
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerGatewayRefused(e.reason, tenantId);
      if (e instanceof GatewayAdminRefused) throw new ResellerGatewayRefused(e.reason, e.message);
      throw e;
    }
  }
}
