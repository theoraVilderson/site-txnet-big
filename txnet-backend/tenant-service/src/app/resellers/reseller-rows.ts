import {
  AdminAction,
  AuditTargetType,
  Prisma,
  TenantBillingModel,
  TenantDomainPurpose,
  TenantDomainType,
  TenantStatus,
  TenantType,
} from '@prisma/client';
import { cnameTargetHost, invalidateTenantOwner, platformCurrencyOf } from '@txnet-backend/shared-core';

import type { RedisService } from '../redis/redis.service';

/**
 * The one way a reseller comes to exist (F-018-c): the platform owner's
 * `POST /api/tenants` and a platform user's purchase (F-019-h) both write
 * these rows, inside their own transaction.
 */

export type OwnerView = { id: string; fullName: string; username: string | null; phoneNumber: string | null };

export type ResellerView = {
  id: string;
  slug: string;
  status: TenantStatus;
  billingModel: string;
  createdAt: Date;
  owner: OwnerView | null;
  domains: { domainValue: string; domainType: TenantDomainType; purpose: TenantDomainPurpose; verificationStatus: string }[];
  billingBalance: string;
};

/**
 * The one platform-issued host of a slug: its own CNAME target (ADR-0060 (6)),
 * unique because the slug is. There is no `<slug>.<domain>` panel host
 * (ADR-0063): the reseller's customers reach it only on a domain of its own,
 * and the target serves nothing itself.
 */
export function resellerHosts(slug: string, base: string): string[] {
  return [cnameTargetHost(slug, base)];
}

/** A slug or its CNAME target already held. The unique indexes stand behind this for a race (`P2002`). */
export async function slugInUse(db: Prisma.TransactionClient, slug: string, targetHost: string): Promise<boolean> {
  const [bySlug, byHost] = await Promise.all([
    db.tenant.findUnique({ where: { slug }, select: { id: true } }),
    db.tenantDomain.findUnique({ where: { domainValue: targetHost }, select: { id: true } }),
  ]);
  return Boolean(bySlug || byHost);
}

export type NewReseller = {
  slug: string;
  hosts: string[];
  billingModel: TenantBillingModel;
  owner: OwnerView;
  /** Who created it: the platform owner's admin, or the buyer. */
  actorId: string;
  ip: string;
};

/**
 * The `tenant` row (`reseller`, `trial`), an empty `tenant_billing_wallet`,
 * the platform-issued `subdomain` row (its CNAME target) and the `tenant_create` audit row, in
 * the caller's cross-tenant transaction. Every entry naming the new tenant's
 * owner is dropped inside it, so a Redis that cannot be reached refuses the
 * whole creation rather than leave a cached *no tenant* on the new host.
 */
export async function writeReseller(tx: Prisma.TransactionClient, redis: RedisService, input: NewReseller): Promise<ResellerView> {
  const tenant = await tx.tenant.create({
    data: {
      tenantType: TenantType.reseller,
      ownerUserId: input.owner.id,
      slug: input.slug,
      status: TenantStatus.trial,
      billingModel: input.billingModel,
    },
  });
  // Empty: no balance is written here (tenant invariant 3).
  await tx.tenantBillingWallet.create({ data: { tenantId: tenant.id, currencyCode: await platformCurrencyOf(tx) } });
  // A subdomain routes as it stands — the platform issued it (tenant invariant 5 is for custom domains).
  const domains = [];
  for (const host of input.hosts) {
    domains.push(
      await tx.tenantDomain.create({
        data: {
          tenantId: tenant.id,
          domainType: TenantDomainType.subdomain,
          domainValue: host,
          purpose: TenantDomainPurpose.panel,
        },
      }),
    );
  }
  const view: ResellerView = {
    id: tenant.id,
    slug: tenant.slug,
    status: tenant.status,
    billingModel: tenant.billingModel,
    createdAt: tenant.createdAt,
    owner: input.owner,
    domains: domains.map((domain) => ({
      domainValue: domain.domainValue,
      domainType: domain.domainType,
      purpose: domain.purpose,
      verificationStatus: domain.verificationStatus,
    })),
    billingBalance: '0',
  };
  await tx.adminAuditLog.create({
    data: {
      tenantId: tenant.id,
      adminId: input.actorId,
      action: AdminAction.tenant_create,
      targetEntityType: AuditTargetType.tenant,
      targetEntityId: tenant.id,
      newValue: JSON.parse(JSON.stringify(view)) as Prisma.InputJsonValue,
      adminIpAddress: input.ip,
    },
  });
  // `auth-service`'s resolver re-reads the rows: every entry naming this tenant's owner goes (F-061-k).
  await invalidateTenantOwner(tx, redis, tenant.id);
  return view;
}
