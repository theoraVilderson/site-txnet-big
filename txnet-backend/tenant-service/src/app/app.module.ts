import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard, TenantStatusGuard } from '@txnet-backend/shared-core';

import { BrandingModule } from './branding/branding.module';
import { BRANDING_PATH } from './branding/tenant-branding.controller';
import { envConfigOptions } from './config/env.validation';
import { DomainsModule } from './domains/domains.module';
import { FileHostMiddleware } from './files/file-host.middleware';
import { FILES_PATH } from './files/files.controller';
import { FilesModule } from './files/files.module';
import { PROBE_PATH } from './domains/domain-check';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
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

/** The file route: public, its tenant from the Host (F-018-m). */
const FILE_ROUTES = `${FILES_PATH}/*path`;

/**
 * `tenant-service` (F-018-t, ADR-0058): tenant administration, out of
 * `auth-service`. Packages arrived with F-018-u, subscription, grace and
 * renewal with F-018-v, status with F-018-w, the resellers themselves with
 * F-018-y, their custom domains with F-018-i, the file route with F-018-m,
 * their branding with F-018-h, the vault's internal seams with F-018-ab,
 * a platform user's reseller purchase with F-019-h, their staff seats with F-018-j.
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
    FilesModule,
    BrandingModule,
    VaultModule,
  ],
  controllers: [HealthController],
  providers: [
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
    // Every route but the health check, the internal seam, the domain
    // probe (public: the sweep's own request, F-018-i), the file route and
    // the public branding read (F-018-h) needs the gate's identity — a moved controller is covered without
    // opting in.
    consumer
      .apply(IdentityMiddleware)
      .exclude('health', INTERNAL_ROUTES, PROBE_PATH, FILE_ROUTES, BRANDING_PATH)
      .forRoutes('{*path}');
    // The file route's tenant is its Host's, not a header's (F-018-m); so is
    // the public branding read's, over the same doors, so every image URL it
    // hands out is one the file route will serve (F-018-h).
    consumer.apply(FileHostMiddleware).forRoutes(FILE_ROUTES, BRANDING_PATH);
  }
}
