import { Injectable } from '@nestjs/common';
import { AuditTargetType, Prisma } from '@prisma/client';
import { platformTenantIdOf, ResellerAccess, ResellerAccessRefused, ResellerActor, SupportConsentRefused, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { auditSelfMoveSettings } from '../grant-audit/grant-audit';
import { ResellerUserGrantsRefused } from '../payment/gift/reseller-user-grants.service';
import type { AdminActor } from '../payment/gift/reseller-user-grants.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  effectiveSelfMove,
  EffectiveSelfMove,
  PLATFORM_SELF_MOVE_DEFAULTS,
  productSelfMoveOf,
  sameOwn,
  SelfMoveOwn,
  SelfMoveValues,
  setsNothing,
  tenantSelfMoveOf,
} from './self-move-setting';

/** The most product overrides one read answers: a tenant's catalog is far smaller (C-28). */
export const MAX_SELF_MOVE_OVERRIDES = 500;

/** The whole view, so the page never computes which value is in effect or where it came from. */
export type SelfMoveSettingsView = {
  platformDefault: SelfMoveValues;
  /** The tenant's own layer; null = inherited from the platform. */
  tenant: SelfMoveOwn;
  /** What a product with no override moves by. */
  effective: EffectiveSelfMove;
  products: (SelfMoveOwn & { productId: string; effective: EffectiveSelfMove })[];
};

export class SelfMoveSettingsRefused extends Error {
  constructor(
    readonly reason: 'product_not_found',
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'SelfMoveSettingsRefused';
  }
}

/**
 * The reseller's self-move setting (F-410-a, `network/contract.config-move.md`
 * "Self-move"): read and set, the tenant's layer and a product's override.
 *
 * **The tenant is the path's**, admitted by the catalog door
 * (`ResellerAccess.for('catalog.manage').runIncludingPlatform`): it is a
 * selling choice, set beside the product. Reads pass `read`, so a suspended
 * reseller sees it; writes pass `staffWrite`. Every change is audited in its
 * transaction; the same values again write neither row nor audit.
 */
@Injectable()
export class SelfMoveSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  settings(actor: ResellerActor, tenantId: string): Promise<SelfMoveSettingsView> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, (tx) => viewOf(tx, scoped())));
  }

  /** The tenant's layer; both null goes back to the platform's. */
  setTenant(actor: AdminActor, tenantId: string, after: SelfMoveOwn): Promise<SelfMoveSettingsView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const tenant = scoped();
        const before = await tenantSelfMoveOf(tx, tenant);
        if (!sameOwn(before, after)) {
          if (setsNothing(after)) await tx.configSelfMoveSetting.deleteMany({ where: { tenantId: tenant } });
          else {
            const row = { ...after, updatedByUserId: actor.userId };
            await tx.configSelfMoveSetting.upsert({ where: { tenantId: tenant }, create: { tenantId: tenant, ...row }, update: row });
          }
          await auditSelfMoveSettings(tx, actor, tenant, { type: AuditTargetType.tenant, id: tenant }, before, after);
        }
        return viewOf(tx, tenant);
      }),
    );
  }

  /** One product's override: the tenant's own product or a platform one; both null removes it. */
  setProduct(actor: AdminActor, tenantId: string, productId: string, after: SelfMoveOwn): Promise<SelfMoveSettingsView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const tenant = scoped();
        // The tenant is in the query (C-15), as RLS has it: its own products and the platform's.
        const product = await tx.product.findFirst({ where: { id: productId, tenantId: { in: [tenant, await platformTenantIdOf(tx)] } }, select: { id: true } });
        if (!product) throw new SelfMoveSettingsRefused('product_not_found', productId);
        const before = await productSelfMoveOf(tx, tenant, productId);
        if (!sameOwn(before, after)) {
          if (setsNothing(after)) await tx.configSelfMoveProductSetting.deleteMany({ where: { tenantId: tenant, productId } });
          else {
            const row = { ...after, updatedByUserId: actor.userId };
            await tx.configSelfMoveProductSetting.upsert({
              where: { tenantId_productId: { tenantId: tenant, productId } },
              create: { tenantId: tenant, productId, ...row },
              update: row,
            });
          }
          await auditSelfMoveSettings(tx, actor, tenant, { type: AuditTargetType.product, id: productId }, before, after);
        }
        return viewOf(tx, tenant);
      }),
    );
  }

  private async admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: () => Promise<T>): Promise<T> {
    try {
      return await this.access.for('catalog.manage').runIncludingPlatform(actor, tenantId, capability, work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused || e instanceof SupportConsentRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
  }
}

const scoped = () => TenantContext.current('self-move settings').id;

async function viewOf(tx: Prisma.TransactionClient, tenantId: string): Promise<SelfMoveSettingsView> {
  const tenant = await tenantSelfMoveOf(tx, tenantId);
  const overrides = await tx.configSelfMoveProductSetting.findMany({
    where: { tenantId },
    select: { productId: true, enabled: true, cooldownHours: true },
    orderBy: { productId: 'asc' },
    take: MAX_SELF_MOVE_OVERRIDES,
  });
  return {
    platformDefault: { ...PLATFORM_SELF_MOVE_DEFAULTS },
    tenant,
    effective: effectiveSelfMove(null, tenant),
    products: overrides.map((o) => ({ ...o, effective: effectiveSelfMove(o, tenant) })),
  };
}
