import { Injectable } from '@nestjs/common';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { TenantCacheService } from './tenant-cache.service';
import {
  ResolvedTenant,
  TenantClaim,
  TenantClaimConflict,
  normalizeHost,
} from './tenant';

type Identified = { id: string; slug: string };

/**
 * Resolves a request's tenant from the claims it carries (ADR-0020, ADR-0025).
 *
 * This is `tenant`'s first service. It lives in the `auth-service` process the
 * way `app/account-switch/` hosts `audit`'s, because its only caller so far is
 * this app's edge — but the rule is tenant's, and `identity` never reads
 * `tenant_domain` itself (§8).
 *
 * Both lookups go through `TenantCacheService`, which is where the caching
 * policy lives — including the reason it is shared rather than in-process
 * (ADR-0025, F-1211). This class stays about the chain.
 *
 * **Why the cross-tenant pool (F-066-m-b).** Both of its queries run before a
 * tenant exists to scope them to: this class is what produces the answer that
 * every other query is then scoped by. Since `tenant.tenant_domain` carries an
 * RLS policy, asking it on the application pool — which has bound no
 * `app.tenant_id`, because there is nothing to bind — returns no rows, and
 * every request on this platform would be answered a neutral 404. So the
 * resolver holds the other client, and holding it is the audit: it is a
 * constructor, not a callback, and `grep -rn CrossTenantPrismaService` lists
 * every reader that has one.
 */
@Injectable()
export class TenantResolverService {
  constructor(
    private readonly prisma: CrossTenantPrismaService,
    private readonly cache: TenantCacheService,
  ) {}

  /**
   * The chain, in order: a session's claim, then a verified service caller's
   * bot claim, then the host. There is no fourth entry (ADR-0025): a request
   * that carries no claim and arrives on a host no `tenant_domain` row matches
   * resolves to `null`, and `TenantGuard` answers it a neutral 404. A fallback
   * cannot tell a misconfigured host from an unknown one, so every stray host
   * used to be served as whichever tenant `DEFAULT_TENANT_SLUG` named.
   *
   * A claim and a surface that both resolve and disagree are **refused**
   * (ADR-0024 decision 4) — `TenantClaimConflict`, never a silent preference
   * for one of them.
   */
  async resolve(claim: TenantClaim): Promise<ResolvedTenant | null> {
    const surface = await this.fromHost(claim.host);
    const claimed = claim.session ?? claim.bot ?? null;
    if (!claimed) {
      return surface ? { ...surface, via: 'domain' } : null;
    }

    const via = claim.session ? 'session' : 'bot';
    if (surface) {
      if (surface.id !== claimed) {
        throw new TenantClaimConflict(claimed, { ...surface, via: 'domain' });
      }
      return { ...surface, via };
    }

    // No surface to agree or disagree with — the claim stands on its own, and
    // is still checked against a real row: a token outliving the tenant it
    // names resolves to nothing rather than to a tenant id nobody owns.
    const tenant = await this.byId(claimed);
    return tenant ? { ...tenant, via } : null;
  }

  /** The tenant a `tenant_domain` row maps this host to, or `null`. */
  private async fromHost(rawHost: string | undefined | null): Promise<Identified | null> {
    const host = normalizeHost(rawHost);
    // A request with no usable host has no surface at all, and there is nothing
    // to look up — the empty host must never be a cache key that could match a
    // row.
    if (!host) return null;

    return this.cache.byHost(host, () => this.lookupHost(host));
  }

  private async lookupHost(host: string): Promise<Identified | null> {
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
    // an unknown host: it has no surface, exactly as a host with no row at all.
    //
    // ASSUMED(2026-09-09): a `suspended` / `terminated` / soft-deleted tenant
    // still resolves. What such a tenant may then *do* is a product rule and
    // belongs to F-018 — see docs/domains/tenant/open-questions.md.
    if (row && (row.domainType === 'subdomain' || row.verificationStatus === 'verified')) {
      return row.tenant;
    }
    return null;
  }

  /** The tenant a claim names, proven against a real row. */
  private async byId(id: string): Promise<Identified | null> {
    return this.cache.byId(id, () =>
      this.prisma.tenant.findUnique({
        where: { id },
        select: { id: true, slug: true },
      }),
    );
  }
}
