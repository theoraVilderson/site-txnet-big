import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PUBLIC_PREFIX, PublicRouteGuard, RateLimitGuard, TenantStatusGuard } from '@txnet-backend/shared-core';

import { BrandingModule } from './branding/branding.module';
import { LEGACY_BRANDING_PATH } from './branding/tenant-branding.controller';
import { envConfigOptions } from './config/env.validation';
import { DomainsModule } from './domains/domains.module';
import { LEGACY_FILES_PATH } from './files/files.controller';
import { FilesModule } from './files/files.module';
import { LEGACY_PROBE_PATH } from './domains/domain-check';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { HostSurfaceCache } from './public/host-surface-cache.service';
import { PublicHostMiddleware } from './public/public-host.middleware';
import { PackagesModule } from './packages/packages.module';
import { PrismaModule } from './prisma/prisma.module';
import { PurchaseModule } from './purchase/purchase.module';
import { RedisModule } from './redis/redis.module';
import { ResellersModule } from './resellers/resellers.module';
import { StaffModule } from './staff/staff.module';
import { StatusModule } from './status/status.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { IdentityMiddleware } from './request/identity.middleware';
import { VaultModule } from './vault/vault.module';

/** The service-to-service seam: reached by the platform's processes, never through Traefik. */
const INTERNAL_ROUTES = 'internal/*path';

/**
 * Every public route (F-018-ak, ADR-0065): no session, the tenant from the Host,
 * each route's doors its own `@PublicRoute`. A controller added under
 * `public/tenant/` is covered here and by Traefik without opting in.
 */
const PUBLIC_ROUTES = `${PUBLIC_PREFIX}/*path`;

/** @deprecated since 2026-09-19, remove after the next release: the public paths before ADR-0065. */
const LEGACY_PUBLIC_ROUTES = [`${LEGACY_FILES_PATH}/*path`, LEGACY_BRANDING_PATH, LEGACY_PROBE_PATH];

/**
 * `tenant-service` (F-018-t, ADR-0058): tenant administration, out of
 * `auth-service`. Packages arrived with F-018-u, subscription, grace and
 * renewal with F-018-v, status with F-018-w, the resellers themselves with
 * F-018-y, their custom domains with F-018-i, the file route with F-018-m,
 * their branding with F-018-h, the vault's internal seams with F-018-ab,
 * a platform user's reseller purchase with F-019-h, their staff seats with F-018-j,
 * the onboarding console's checklist with F-018-l.
 */
@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    PrismaModule,
    RedisModule,
    LocaleModule,
    PackagesModule,
    SubscriptionModule,
    StatusModule,
    ResellersModule,
    PurchaseModule,
    DomainsModule,
    StaffModule,
    OnboardingModule,
    FilesModule,
    BrandingModule,
    VaultModule,
  ],
  controllers: [HealthController],
  providers: [
    // The public prefix's Host lookup, read through `tenant:host:<host>`
    // (F-018-al). A provider of the app module because its only consumer is
    // the middleware configured below, which is the app module's too.
    HostSurfaceCache,
    // First, so a public route on a door it does not serve is the neutral 404
    // before anything judges its tenant (F-018-ak).
    { provide: APP_GUARD, useClass: PublicRouteGuard },
    // Per-user limits, opted into per route with `@RateLimit` (F-092-r).
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // What the tenant's status allows (C-11): the tenant is the scope
    // IdentityMiddleware opened; `internal/*` has none and is not judged.
    { provide: APP_GUARD, useClass: TenantStatusGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Language first, so the 401 IdentityMiddleware throws is translated.
    consumer.apply(LanguageMiddleware).forRoutes('{*path}');
    // Every route but the health check, the internal seam and the public
    // routes needs the gate's identity — a moved controller is covered without
    // opting in.
    consumer
      .apply(IdentityMiddleware)
      .exclude('health', INTERNAL_ROUTES, PUBLIC_ROUTES, ...LEGACY_PUBLIC_ROUTES)
      .forRoutes('{*path}');
    // A public route's tenant is its Host's, not a header's (ADR-0065).
    consumer.apply(PublicHostMiddleware).forRoutes(PUBLIC_ROUTES, ...LEGACY_PUBLIC_ROUTES);
  }
}
