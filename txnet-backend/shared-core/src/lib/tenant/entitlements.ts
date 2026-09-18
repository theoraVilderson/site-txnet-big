import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EntitlementSource } from '@prisma/client';
import { BackendI18nKeys } from '../i18n/keys.backend.generated';
import { TenantContext } from '../tenant-context/tenant-context';
import type { TenantFeatureKey } from './feature-keys';

/**
 * Whether a tenant may use a feature (F-018-g, tenant invariant 6).
 *
 * A key is on when **any** `tenant_feature_entitlement` row for it is enabled
 * and not expired — a package, an add-on or a grant by hand all count the
 * same. The platform owner is entitled to every key without a row: it is the
 * one selling them (user, 2026-09-18), so a key added to
 * `TENANT_FEATURE_KEYS` never needs seeding for the platform's own site.
 *
 * Status is not judged here — `TenantStatusGuard` does that first.
 */

export interface TenantEntitlementRow {
  source: EntitlementSource;
  expiresAt: Date | null;
}

/** The two reads this needs. An app binds its Prisma client (the cross-tenant pool: `tenant` has no `tenantId`). */
export interface TenantEntitlementReader {
  tenant: {
    findUnique(args: { where: { id: string }; select: { tenantType: true } }): Promise<{ tenantType: string } | null>;
  };
  tenantFeatureEntitlement: {
    findMany(args: {
      where: { tenantId: string; featureKey: string; isEnabled: true };
      select: { source: true; expiresAt: true };
    }): Promise<TenantEntitlementRow[]>;
  };
}

export type TenantEntitlementDecision =
  | { allowed: true; source: EntitlementSource | 'platform_owner'; expiresAt: Date | null }
  | { allowed: false };

/** The DI token an app binds its {@link TenantEntitlementReader} to. */
export const TENANT_ENTITLEMENT_READER = Symbol('TENANT_ENTITLEMENT_READER');

@Injectable()
export class TenantEntitlements {
  constructor(@Inject(TENANT_ENTITLEMENT_READER) private readonly db: TenantEntitlementReader) {}

  async allows(tenantId: string, featureKey: TenantFeatureKey, now: Date = new Date()): Promise<boolean> {
    return (await this.check(tenantId, featureKey, now)).allowed;
  }

  /** The live row that lasts longest wins the report; a row with no expiry lasts longest of all. */
  async check(tenantId: string, featureKey: TenantFeatureKey, now: Date = new Date()): Promise<TenantEntitlementDecision> {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    if (!tenant) return { allowed: false };
    if (tenant.tenantType === 'platform_owner') return { allowed: true, source: 'platform_owner', expiresAt: null };

    const rows = await this.db.tenantFeatureEntitlement.findMany({
      where: { tenantId, featureKey, isEnabled: true },
      select: { source: true, expiresAt: true },
    });
    let best: TenantEntitlementRow | null = null;
    for (const row of rows) {
      if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue;
      if (!best || (best.expiresAt && (!row.expiresAt || row.expiresAt > best.expiresAt))) best = row;
    }
    return best ? { allowed: true, source: best.source, expiresAt: best.expiresAt } : { allowed: false };
  }
}

export const TENANT_FEATURE_KEY = 'tenant_feature';

const REFUSAL = { i18nKey: BackendI18nKeys.errors.tenant.featureNotEntitled, reason: 'tenantFeatureNotEntitled' };

/**
 * Refuses a request whose tenant is not entitled to the route's feature, with
 * `403 tenant.featureNotEntitled`. Attached by {@link RequiresFeature}, never
 * registered on its own. The app provides {@link TenantEntitlements} and binds
 * {@link TENANT_ENTITLEMENT_READER}.
 */
@Injectable()
export class TenantEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: TenantEntitlements,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const featureKey = this.reflector.getAllAndOverride<TenantFeatureKey | undefined>(TENANT_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!featureKey) return true;

    // A feature is always some tenant's; a gated route reached with none in scope is refused, not waved through.
    const tenant = TenantContext.currentOrNull();
    if (tenant && (await this.entitlements.allows(tenant.id, featureKey))) return true;
    throw new ForbiddenException(REFUSAL);
  }
}

/** Gates a route (or a controller) on a feature key; the guard comes with it. */
export const RequiresFeature = (featureKey: TenantFeatureKey) =>
  applyDecorators(SetMetadata(TENANT_FEATURE_KEY, featureKey), UseGuards(TenantEntitlementGuard));
