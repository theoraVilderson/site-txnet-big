import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PublicRouteGuard, RateLimitGuard, TenantStatusGuard } from '@txnet-backend/shared-core';

import { envConfigOptions } from './config/env.validation';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
import { PrismaModule } from './prisma/prisma.module';
import { CurrencyRatesModule } from './rates/rates.module';
import { RedisModule } from './redis/redis.module';
import { IdentityMiddleware } from './request/identity.middleware';

/**
 * currency-service (ADR-0100). The shared guards every tenant-facing app
 * registers (C-11): a suspended tenant's routes are refused here as anywhere.
 */
@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), PrismaModule, RedisModule, LocaleModule, CurrencyRatesModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: PublicRouteGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: TenantStatusGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LanguageMiddleware).forRoutes('{*path}');
    consumer.apply(IdentityMiddleware).exclude('health').forRoutes('{*path}');
  }
}
