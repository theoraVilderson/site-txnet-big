import { Injectable } from '@nestjs/common';
import { ConnectionTestFault, DriverType, PanelOwnershipType, PanelReviewState, PanelRole } from '@prisma/client';
import { ResellerAccess, tenantTransaction, type ResellerActor } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { PanelRegistrationService, type PanelOwner } from '../systems/panel-registration';
import { SystemsRefused } from '../systems/systems-read';
import { admitMigration } from './migration-door';
import { IN_PLACE_DECLARATION, IN_PLACE_FAMILIES, isInPlaceFamily } from './migration-plan';
import { MigrationRunRefused } from './migration-run';

/**
 * A reseller's router carries a region because every panel does; none is
 * placed by region (no group places a user on it, ADR-0160 decision 6), so
 * this one names the owner kind, not a place (ADR-0162 decision 4).
 */
export const RESELLER_ROUTER_REGION = 'reseller';

/** A reseller holds a handful of routers; the list is bounded all the same (C-28). */
const ROUTERS_MAX = 100;

/** What the reseller types: the family decides the rest of the declaration. */
export type ResellerRouterInput = { family: DriverType; name: string; apiBaseUrl: string; credentials: string };

/** One router as the import page lists it: its address's origin only (a path can be a secret), and its connection test. */
export type ResellerRouterView = {
  id: string;
  name: string;
  family: DriverType;
  address: string | null;
  reviewState: PanelReviewState;
  fault: ConnectionTestFault | null;
  testedAt: string | null;
};

const ROUTER_FIELDS = {
  id: true,
  name: true,
  driverType: true,
  apiBaseUrl: true,
  reviewState: true,
  connectionTestFault: true,
  connectionTestedAt: true,
} as const;

const originOf = (url: string | null): string | null => (url && URL.canParse(url) ? new URL(url).origin : null);

/**
 * A reseller registers its own router for an import in place (F-1601-g,
 * ADR-0162): the systems page's registration, behind the import's door
 * (`migration.manage`) instead of the owner's, for a family imported in place
 * only. The panel is the path's tenant's — never the session's, so the owner
 * acting in a reseller's workspace registers the reseller's router — and its
 * login is sealed under that tenant. Network tests it as any panel and tells
 * its verdict on the reseller's `tenant:` channel (`network.panel.tested`).
 */
@Injectable()
export class MigrationRouterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly registration: PanelRegistrationService,
  ) {}

  /** The reseller's own live routers of a family imported in place, by name. */
  list(actor: ResellerActor, tenantId: string): Promise<{ routers: ResellerRouterView[] }> {
    return admitMigration(this.access, { actor, tenantId, capability: 'read' }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const rows = await tx.panel.findMany({
          where: { ...ownerOf(tenantId).scope, driverType: { in: IN_PLACE_FAMILIES }, retiredAt: null },
          select: ROUTER_FIELDS,
          orderBy: { name: 'asc' },
          take: ROUTERS_MAX,
        });
        return {
          routers: rows.map((r) => ({
            id: r.id,
            name: r.name,
            family: r.driverType,
            address: originOf(r.apiBaseUrl),
            reviewState: r.reviewState,
            fault: r.connectionTestFault,
            testedAt: r.connectionTestedAt?.toISOString() ?? null,
          })),
        };
      }),
    );
  }

  /** `pending` until network's connection test answers; `family_not_in_place` for any other family. */
  register(actor: ResellerActor, tenantId: string, input: ResellerRouterInput) {
    return admitMigration(this.access, { actor, tenantId, capability: 'staffWrite' }, () => {
      const { family } = input;
      if (!isInPlaceFamily(family)) throw new MigrationRunRefused('family_not_in_place', family);
      return this.registration.registerFor(ownerOf(tenantId), actor.userId, {
        name: input.name,
        apiBaseUrl: input.apiBaseUrl,
        driverType: family,
        ...IN_PLACE_DECLARATION[family],
        role: PanelRole.active,
        region: RESELLER_ROUTER_REGION,
        credentials: input.credentials,
      });
    });
  }

  /** A login re-entered on one of the reseller's routers: another tenant's, or none, is `panel_not_found`. */
  resubmit(actor: ResellerActor, tenantId: string, panelId: string, credentials: string) {
    return admitMigration(this.access, { actor, tenantId, capability: 'staffWrite' }, async () => {
      try {
        return await this.registration.resubmitFor(ownerOf(tenantId), actor.userId, panelId, credentials);
      } catch (e) {
        if (e instanceof SystemsRefused && e.reason === 'not_found') throw new MigrationRunRefused('panel_not_found', panelId);
        throw e;
      }
    });
  }
}

/** The reseller as a panel owner: its own panels, its own vault entries (ADR-0162 decision 2). */
function ownerOf(tenantId: string): PanelOwner {
  return { scope: { ownershipType: PanelOwnershipType.tenant, tenantId }, vaultTenantId: tenantId };
}
