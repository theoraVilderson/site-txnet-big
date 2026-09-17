import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from '@txnet-backend/shared-core';

import { CampaignsModule } from './campaigns/campaigns.module';
import { envConfigOptions } from './config/env.validation';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { IdentityMiddleware } from './request/identity.middleware';

/** The service-to-service seam: reached by the platform's processes, never through Traefik. */
const INTERNAL_ROUTES = 'internal/*';

@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    PrismaModule,
    RedisModule,
    LocaleModule,
    NotificationsModule,
    CampaignsModule,
  ],
  controllers: [HealthController],
  // Per-user limits, opted into per route with `@RateLimit` (F-092-r).
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Language first, so the 401 IdentityMiddleware throws is translated.
    consumer.apply(LanguageMiddleware).forRoutes('*');
    // Every route but the health check and the internal seam needs the gate's
    // identity — a new controller is covered without opting in, billing's rule.
    // `ServiceOnlyGuard` is the whole door on `internal/*`.
    consumer
      .apply(IdentityMiddleware)
      .exclude('health', INTERNAL_ROUTES)
      .forRoutes('*');
  }
}
