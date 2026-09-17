import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard, TenantStatusGuard } from '@txnet-backend/shared-core';

import { envConfigOptions } from './config/env.validation';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { IdentityMiddleware } from './request/identity.middleware';

/** The service-to-service seam: reached by the platform's processes, never through Traefik. */
const INTERNAL_ROUTES = 'internal/*';

/**
 * `tenant-service` (F-018-t, ADR-0058): tenant administration, out of
 * `auth-service`. No business routes yet — packages, subscription, status and
 * resellers move in with F-018-u … F-018-y, and inherit this wiring.
 */
@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    PrismaModule,
    RedisModule,
    LocaleModule,
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
    consumer.apply(LanguageMiddleware).forRoutes('*');
    // Every route but the health check and the internal seam needs the gate's
    // identity — a moved controller is covered without opting in.
    consumer
      .apply(IdentityMiddleware)
      .exclude('health', INTERNAL_ROUTES)
      .forRoutes('*');
  }
}
