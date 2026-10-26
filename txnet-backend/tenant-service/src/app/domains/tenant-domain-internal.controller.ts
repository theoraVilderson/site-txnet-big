import { Controller, Get, Header, HttpCode, HttpStatus, NotFoundException, Post, Query, Req, UseGuards } from '@nestjs/common';
import { EDGE_DOOR_HEADER, headerValue, PublicRoute, RequestHeaders, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { LEGACY_PROBE_PATH, PROBE_NONCE, PROBE_PATH } from './domain-check';
import { DomainSweep, TenantDomainService } from './tenant-domain.service';

/**
 * The sweep the `tenant_domain_verification` job ticks (F-018-i), reached only
 * by `worker-service` with `SERVICE_AUTH_TOKEN`. Repeats safely: a row is
 * written only in the status it was read in.
 */
@Controller('internal/tenant-domains')
@UseGuards(ServiceOnlyGuard)
export class TenantDomainInternalController {
  constructor(private readonly domains: TenantDomainService) {}

  @Post('check-due')
  @HttpCode(HttpStatus.OK)
  checkDue(): Promise<DomainSweep> {
    return this.domains.checkDue();
  }
}

/**
 * What the http and https checks request through the reseller's domain:
 * `GET /api/public/tenant/domain-probe?n=<nonce>`. Public (ADR-0065) because the
 * request is the sweep's own, arriving from outside through the tenant's CDN.
 * `'none'` doors: the Host is not the proof here — an unverified custom domain
 * has no surface yet, and this request is how it gets one; `probeAnswer` checks
 * the row itself. `system`, so a suspended reseller's domain is still checked.
 *
 * It answers the host the request arrived as and the nonce, and only on a host
 * with a `tenant_domain` row; anything else is the neutral 404 (F-1210).
 *
 * The nonce comes in the query, or in `x-domain-probe` for the cache line: two
 * requests to one URL, as two signed-in users load one page, and the answer is
 * `private, no-store` — a CDN that serves the second the first one's answer
 * fails the check (ADR-0129 (8), EDGE-1-e).
 *
 * `door` is the gateway's `X-Edge-Door` (NIN-1-e2): an own-edge domain passes
 * only through the domestic door. The WebSocket line is `DomainProbeSocket`'s.
 */
@Controller([PROBE_PATH, LEGACY_PROBE_PATH])
export class DomainProbeController {
  constructor(private readonly domains: TenantDomainService) {}

  @Get()
  @PublicRoute({ doors: 'none' })
  @TenantCapability('system')
  @Header('Cache-Control', 'private, no-store')
  async probe(@Req() req: Request, @Query('n') query: unknown): Promise<{ host: string; nonce: string; door: string | null }> {
    const nonce = query ?? headerValue(req.headers, RequestHeaders.domainProbe);
    const answer = typeof nonce === 'string' && PROBE_NONCE.test(nonce) ? await this.domains.probeAnswer(req.hostname, nonce) : null;
    if (!answer) throw new NotFoundException();
    return { ...answer, door: headerValue(req.headers, EDGE_DOOR_HEADER) ?? null };
  }
}
