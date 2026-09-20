import { HttpException, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PUBLIC_SURFACE,
  RateLimitBucket,
  RateLimiter,
  normalizeHost,
  rateLimitBucketKey,
  runWithTenant,
} from '@txnet-backend/shared-core';
import type { NextFunction, Request, Response } from 'express';

import type { EnvConfig } from '../config/env.validation';
import { HostSurfaceCache } from './host-surface-cache.service';

/** The window `PUBLIC_ROUTE_RATE_LIMIT` counts over. On the route by contract, as every `@RateLimit` keeps it. */
export const PUBLIC_ROUTE_WINDOW_SEC = 60;

/**
 * The Host half of every public route here (F-018-ak, ADR-0065): the routes
 * under `public/tenant/`, which Traefik sends with no `my-auth` and no session.
 *
 * It names the surface the Host proves ({@link HostSurfaceCache}, which reads
 * `tenant:host:<host>` through Redis since F-018-al) and puts it on the request
 * — `null` for none — and opens that tenant's scope, so a route holds a key
 * against it and one reseller's domain never serves another's file. It refuses
 * nothing on the surface's account: which doors a route answers on is the
 * route's own `@PublicRoute`, and `PublicRouteGuard` enforces it.
 *
 * tenant-service reads `Host`, not `X-Forwarded-Host`: the panel's internal hop
 * sets `Host` itself (`site-pwa/src/lib/host-get.ts`).
 *
 * **The rate limit is spent here, for the whole prefix, and not as a
 * `@RateLimit` per route** (F-018-al). A public route is meant to be a
 * controller and a decorator; a limit each one opts into is a limit the next
 * one silently does without, on routes nobody signs in to. Middleware runs
 * before every guard, so it also counts the requests `PublicRouteGuard`
 * answers with the neutral 404 — a flood on a host matching no
 * `tenant_domain` row is still a flood, and `RedisKeys.rateLimit` files it
 * under `none` rather than throwing.
 */
@Injectable()
export class PublicHostMiddleware implements NestMiddleware {
  private readonly limit: number;

  constructor(
    private readonly surfaces: HostSurfaceCache,
    private readonly rateLimiter: RateLimiter,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.limit = config.get('PUBLIC_ROUTE_RATE_LIMIT', { infer: true });
  }

  async use(req: Request, _res: Response, next: NextFunction) {
    const surface = await this.surfaces.of(normalizeHost(req.headers.host));
    (req as unknown as Record<symbol, unknown>)[PUBLIC_SURFACE] = surface;
    // `next()` runs inside the scope, as `IdentityMiddleware` runs it — and so
    // does the counter, so `RedisKeys.rateLimit` files it under the host's
    // tenant. The budget is therefore per reseller and the subject is the
    // visitor: one attacker is cut off, not every visitor to the reseller they
    // aimed at (user, 2026-09-20).
    return runWithTenant(surface ? { id: surface.id } : null, async () => {
      await this.spend(req);
      next();
    });
  }

  /**
   * Two counters, both incremented before either is judged, exactly as
   * `RateLimitGuard` spends a route's own limit: the tenant's budget, and the
   * platform-wide ceiling over the same bucket (F-066-s). A refused request is
   * still traffic, so it counts in both — hammering the prefix keeps the window
   * open rather than resetting it.
   */
  private async spend(req: Request): Promise<void> {
    const bucket = rateLimitBucketKey(RateLimitBucket.PUBLIC_ROUTE, req.ip ?? 'unknown');
    const tenant = await this.rateLimiter.hit(bucket, this.limit, PUBLIC_ROUTE_WINDOW_SEC);
    const platform = await this.rateLimiter.hitPlatform(bucket, this.limit, PUBLIC_ROUTE_WINDOW_SEC);
    if (!tenant.allowed || !platform.allowed) throw new HttpException('Too Many Requests', 429);
  }
}
