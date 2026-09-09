import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ResolvedTenant, normalizeHost } from './tenant';

/**
 * How long a resolved host is trusted before it is looked up again.
 *
 * ADR-0020 accepts a lookup per request and says it belongs in a cache. This is
 * that cache, and it is deliberately the simplest one that can be correct: no
 * cross-process invalidation, because there is no writer to invalidate against
 * — tenant administration (adding a domain, verifying one) is F-018. A minute
 * is short enough that a newly verified domain works without a restart, and
 * long enough that the read stops being per-request.
 */
export const TENANT_CACHE_TTL_MS = 60_000;

type CacheEntry = { value: ResolvedTenant | null; expiresAt: number };

/**
 * Resolves a request's tenant from its host (ADR-0020).
 *
 * This is `tenant`'s first service. It lives in the `auth-service` process the
 * way `app/account-switch/` hosts `audit`'s, because its only caller so far is
 * this app's edge — but the rule is tenant's, and `identity` never reads
 * `tenant_domain` itself (§8).
 */
@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async resolve(rawHost: string | undefined | null): Promise<ResolvedTenant | null> {
    const host = normalizeHost(rawHost);
    // A request with no usable host still gets an answer — the fallback — so
    // the empty key is a cache entry like any other rather than a special case.
    const key = host ?? '';

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value = await this.lookup(host);
    this.cache.set(key, { value, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
    return value;
  }

  private async lookup(host: string | null): Promise<ResolvedTenant | null> {
    if (host) {
      const row = await this.prisma.tenantDomain.findUnique({
        where: { domainValue: host },
        select: {
          domainType: true,
          verificationStatus: true,
          tenant: { select: { id: true, slug: true } },
        },
      });

      // A subdomain is issued by the platform, so matching the row is the whole
      // proof. A custom domain is claimed by the reseller and is only theirs
      // once ownership has been proven — `verificationStatus` defaults to
      // `pending` and the schema documents it as meaningful for custom domains
      // only (prisma/domains/tenant.prisma). An unverified one is treated as
      // an unknown host: it falls through to the fallback below, exactly as a
      // host with no row at all does.
      //
      // ASSUMED(2026-09-09): a `suspended` / `terminated` / soft-deleted tenant
      // still resolves. What such a tenant may then *do* is a product rule and
      // belongs to F-018 — see docs/domains/tenant/open-questions.md.
      if (row && (row.domainType === 'subdomain' || row.verificationStatus === 'verified')) {
        return { id: row.tenant.id, slug: row.tenant.slug, via: 'domain' };
      }
    }

    return this.defaultTenant();
  }

  /**
   * The deployment's configured tenant, for a host that matched nothing.
   *
   * ADR-0020's accepted cost, stated where it is paid: in a deployment that
   * serves resellers this silently absorbs every misconfigured host, so
   * `DEFAULT_TENANT_SLUG` must be set on purpose there and never left at the
   * single-tenant default.
   */
  private async defaultTenant(): Promise<ResolvedTenant | null> {
    const slug = this.config.get<string>('DEFAULT_TENANT_SLUG');
    if (!slug) throw new Error('DEFAULT_TENANT_SLUG is required');

    const tenant = await this.prisma.tenant.findFirst({
      where: { slug },
      select: { id: true, slug: true },
    });
    if (!tenant) {
      this.logger.warn(`no tenant with slug '${slug}' — requests resolve to no tenant`);
      return null;
    }
    return { id: tenant.id, slug: tenant.slug, via: 'default' };
  }
}
